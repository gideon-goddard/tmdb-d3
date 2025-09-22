// Global variables
let socket = null;
let simulation = null;
let svg = null;
let g = null;
let nodes = [];
let links = [];
let allPaths = [];
let currentHighlightedPath = null;

// Initialize the application
document.addEventListener('DOMContentLoaded', function() {
    initializeVisualization();
    setupWebSocket();
});

function initializeVisualization() {
    const container = d3.select('.visualization-container');
    const containerRect = container.node().getBoundingClientRect();
    
    svg = d3.select('#graph')
        .attr('width', containerRect.width)
        .attr('height', containerRect.height);
    
    // Create a group for zoom/pan
    g = svg.append('g');
    
    // Set up zoom behavior
    const zoom = d3.zoom()
        .scaleExtent([0.1, 4])
        .on('zoom', function(event) {
            g.attr('transform', event.transform);
        });
    
    svg.call(zoom);
    
    // Initialize force simulation
    simulation = d3.forceSimulation()
        .force('link', d3.forceLink().id(d => d.id).distance(100))
        .force('charge', d3.forceManyBody().strength(-300))
        .force('center', d3.forceCenter(containerRect.width / 2, containerRect.height / 2))
        .force('collision', d3.forceCollide().radius(20));
    
    // Handle window resize
    window.addEventListener('resize', function() {
        const newRect = container.node().getBoundingClientRect();
        svg.attr('width', newRect.width).attr('height', newRect.height);
        simulation.force('center', d3.forceCenter(newRect.width / 2, newRect.height / 2));
        simulation.alpha(0.3).restart();
    });
}

function setupWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    
    socket = new WebSocket(wsUrl);
    
    socket.onopen = function() {
        console.log('WebSocket connected');
        updateStatus('Connected to server');
    };
    
    socket.onmessage = function(event) {
        const data = JSON.parse(event.data);
        handleWebSocketMessage(data);
    };
    
    socket.onclose = function() {
        console.log('WebSocket disconnected');
        updateStatus('Disconnected from server', 'error');
        
        // Try to reconnect after 3 seconds
        setTimeout(setupWebSocket, 3000);
    };
    
    socket.onerror = function(error) {
        console.error('WebSocket error:', error);
        updateStatus('Connection error', 'error');
    };
}

function handleWebSocketMessage(data) {
    switch(data.type) {
        case 'actors_found':
            updateStatus(`Found actors: ${data.actor1.name} and ${data.actor2.name}`);
            clearVisualization();
            break;
            
        case 'progress':
            updateProgress(data);
            break;
            
        case 'complete_graph':
            hideProgress();
            updateStatus(`Found ${data.paths.length} connection path(s)!`, 'success');
            // Load the complete graph at once
            nodes = data.nodes;
            links = data.edges;
            allPaths = data.paths;
            updateVisualization();
            populatePathDropdown();
            break;
            
        case 'no_connection':
            hideProgress();
            updateStatus(data.message, 'error');
            break;
            
        case 'error':
            hideProgress();
            updateStatus(`Error: ${data.error}`, 'error');
            break;
    }
}

function findConnections() {
    const actor1 = document.getElementById('actor1').value.trim();
    const actor2 = document.getElementById('actor2').value.trim();
    
    if (!actor1 || !actor2) {
        updateStatus('Please enter both actor names', 'error');
        return;
    }
    
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        updateStatus('Not connected to server', 'error');
        return;
    }
    
    updateStatus('Starting search...', 'loading');
    showProgress();
    document.getElementById('searchBtn').disabled = true;
    document.getElementById('pathSelector').style.display = 'none';
    
    const message = {
        type: 'find_connections',
        actor1: actor1,
        actor2: actor2
    };
    
    socket.send(JSON.stringify(message));
}

function showProgress() {
    document.getElementById('progressContainer').style.display = 'block';
    updateProgressBar(0, 'Initializing...', '');
}

function hideProgress() {
    document.getElementById('progressContainer').style.display = 'none';
    document.getElementById('searchBtn').disabled = false;
}

function updateProgress(data) {
    const message = data.message || 'Processing...';
    const progress = data.progress || 0;
    
    // Build details string
    let details = [];
    if (data.stage) details.push(`Stage: ${data.stage}`);
    if (data.depth) details.push(`Depth: ${data.depth}`);
    if (data.queue_size) details.push(`Queue: ${data.queue_size}`);
    if (data.current_type) details.push(`Type: ${data.current_type}`);
    if (data.processed && data.total_in_level) {
        details.push(`Progress: ${data.processed}/${data.total_in_level}`);
    }
    
    updateProgressBar(progress, message, details.join(' • '));
}

function updateProgressBar(percent, message, details) {
    document.getElementById('progressFill').style.width = `${percent}%`;
    document.getElementById('progressMessage').textContent = message;
    document.getElementById('progressPercent').textContent = `${Math.round(percent)}%`;
    document.getElementById('progressDetails').textContent = details;
}

function clearVisualization() {
    nodes = [];
    links = [];
    allPaths = [];
    currentHighlightedPath = null;
    
    g.selectAll('.link').remove();
    g.selectAll('.node').remove();
    g.selectAll('.node-label').remove();
    
    document.getElementById('pathDropdown').innerHTML = '<option value="">Select a path to highlight</option>';
    document.getElementById('pathSelector').style.display = 'none';
    document.getElementById('searchBtn').disabled = false;
}

function updateVisualization() {
    // Update simulation
    simulation.nodes(nodes);
    simulation.force('link').links(links);
    
    // Update links
    const link = g.selectAll('.link')
        .data(links, d => `${d.source.id || d.source}-${d.target.id || d.target}`);
    
    link.enter()
        .append('line')
        .attr('class', 'link');
    
    link.exit().remove();
    
    // Update nodes
    const node = g.selectAll('.node')
        .data(nodes, d => d.id);
    
    const nodeEnter = node.enter()
        .append('circle')
        .attr('class', d => `node ${d.type.replace('_', '-')}`)  // Convert underscores to hyphens for CSS
        .attr('r', 8)
        .call(d3.drag()
            .on('start', dragstarted)
            .on('drag', dragged)
            .on('end', dragended))
        .on('mouseover', function(event, d) {
            d3.select(this).transition().duration(200).attr('r', 12);
        })
        .on('mouseout', function(event, d) {
            if (!d3.select(this).classed('highlighted')) {
                d3.select(this).transition().duration(200).attr('r', 8);
            }
        });
    
    node.exit().remove();
    
    // Update labels
    const label = g.selectAll('.node-label')
        .data(nodes, d => d.id);
    
    label.enter()
        .append('text')
        .attr('class', 'node-label')
        .text(d => {
            return d.name.length > 15 ? d.name.substring(0, 15) + '...' : d.name;
        });
    
    label.exit().remove();
    
    // Restart simulation with proper alpha
    simulation.alpha(1).restart();
    
    // Update positions on tick - ensure this is set every time
    simulation.on('tick', () => {
        g.selectAll('.link')
            .attr('x1', d => (d.source.x !== undefined ? d.source.x : 0))
            .attr('y1', d => (d.source.y !== undefined ? d.source.y : 0))
            .attr('x2', d => (d.target.x !== undefined ? d.target.x : 0))
            .attr('y2', d => (d.target.y !== undefined ? d.target.y : 0));
        
        g.selectAll('.node')
            .attr('cx', d => d.x)
            .attr('cy', d => d.y);
        
        g.selectAll('.node-label')
            .attr('x', d => d.x)
            .attr('y', d => d.y + 25);
    });
}

function populatePathDropdown() {
    const dropdown = document.getElementById('pathDropdown');
    dropdown.innerHTML = '<option value="">Select a path to highlight</option>';
    
    allPaths.forEach((path, index) => {
        const pathNames = path.map(id => {
            const node = nodes.find(n => n.id === id);
            return node ? node.name : id;
        });
        
        const option = document.createElement('option');
        option.value = index;
        option.textContent = `Path ${index + 1}: ${pathNames.join(' → ')}`;
        dropdown.appendChild(option);
    });
    
    document.getElementById('pathSelector').style.display = 'flex';
}

function highlightPath() {
    const dropdown = document.getElementById('pathDropdown');
    const selectedIndex = dropdown.value;
    
    // Clear previous highlights
    g.selectAll('.node').classed('highlighted', false);
    g.selectAll('.link').classed('highlighted', false);
    g.selectAll('.node-label').classed('highlighted', false);
    
    if (selectedIndex === '') {
        currentHighlightedPath = null;
        return;
    }
    
    const path = allPaths[selectedIndex];
    currentHighlightedPath = path;
    
    // Highlight nodes in path
    path.forEach(nodeId => {
        g.selectAll('.node')
            .filter(d => d.id === nodeId)
            .classed('highlighted', true);
        
        g.selectAll('.node-label')
            .filter(d => d.id === nodeId)
            .classed('highlighted', true);
    });
    
    // Highlight edges in path
    for (let i = 0; i < path.length - 1; i++) {
        const sourceId = path[i];
        const targetId = path[i + 1];
        
        g.selectAll('.link')
            .filter(d => {
                const source = d.source.id || d.source;
                const target = d.target.id || d.target;
                return (source === sourceId && target === targetId) ||
                       (source === targetId && target === sourceId);
            })
            .classed('highlighted', true);
    }
}

function updateStatus(message, type = '') {
    const statusElement = document.getElementById('status');
    statusElement.textContent = message;
    statusElement.className = `status ${type}`;
    
    if (type === 'loading') {
        statusElement.classList.add('loading');
    }
}

// Drag functions
function dragstarted(event, d) {
    if (!event.active) simulation.alphaTarget(0.3).restart();
    d.fx = d.x;
    d.fy = d.y;
}

function dragged(event, d) {
    d.fx = event.x;
    d.fy = event.y;
}

function dragended(event, d) {
    if (!event.active) simulation.alphaTarget(0);
    d.fx = null;
    d.fy = null;
}

// Handle Enter key in input fields
document.getElementById('actor1').addEventListener('keypress', function(event) {
    if (event.key === 'Enter') {
        document.getElementById('actor2').focus();
    }
});

document.getElementById('actor2').addEventListener('keypress', function(event) {
    if (event.key === 'Enter') {
        findConnections();
    }
});

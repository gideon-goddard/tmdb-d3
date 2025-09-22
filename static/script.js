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
            // Add the initial search actors to the graph
            addNode({...data.actor1, type: 'search_actor'});
            addNode({...data.actor2, type: 'search_actor'});
            break;
            
        case 'node_added':
            addNode(data.node);
            break;
            
        case 'edge_added':
            addEdge(data.edge);
            break;
            
        case 'connections_found':
            updateStatus(`Found ${data.paths.length} connection path(s)!`, 'success');
            allPaths = data.paths;
            populatePathDropdown();
            break;
            
        case 'no_connection':
            updateStatus(data.message, 'error');
            break;
            
        case 'error':
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
    
    updateStatus('Searching for connections...', 'loading');
    document.getElementById('searchBtn').disabled = true;
    document.getElementById('pathSelector').style.display = 'none';
    
    const message = {
        type: 'find_connections',
        actor1: actor1,
        actor2: actor2
    };
    
    socket.send(JSON.stringify(message));
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

function addNode(nodeData) {
    // Check if node already exists
    if (nodes.find(n => n.id === nodeData.id)) {
        return;
    }
    
    nodes.push(nodeData);
    updateVisualization();
}

function addEdge(edgeData) {
    // Check if edge already exists
    if (links.find(l => l.source.id === edgeData.source && l.target.id === edgeData.target)) {
        return;
    }
    
    links.push(edgeData);
    updateVisualization();
}

function updateVisualization() {
    // Update simulation
    simulation.nodes(nodes);
    simulation.force('link').links(links);
    
    // Update links
    const link = g.selectAll('.link')
        .data(links, d => `${d.source.id || d.source}-${d.target.id || d.target}`);
    
    const linkEnter = link.enter()
        .append('line')
        .attr('class', 'link');
    
    link.exit().remove();
    
    // Update nodes
    const node = g.selectAll('.node')
        .data(nodes, d => d.id);
    
    const nodeEnter = node.enter()
        .append('circle')
        .attr('class', d => `node ${d.type}`)
        .attr('r', 8)
        .call(d3.drag()
            .on('start', dragstarted)
            .on('drag', dragged)
            .on('end', dragended))
        .on('mouseover', function(event, d) {
            // Show tooltip
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
    
    const labelEnter = label.enter()
        .append('text')
        .attr('class', 'node-label')
        .text(d => {
            // Truncate long names
            return d.name.length > 15 ? d.name.substring(0, 15) + '...' : d.name;
        });
    
    label.exit().remove();
    
    // Restart simulation
    simulation.alpha(0.3).restart();
    
    // Update positions on tick
    simulation.on('tick', () => {
        g.selectAll('.link')
            .attr('x1', d => d.source.x)
            .attr('y1', d => d.source.y)
            .attr('x2', d => d.target.x)
            .attr('y2', d => d.target.y);
        
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

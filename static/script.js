// Global variables
let socket = null;
let simulation = null;
let svg = null;
let g = null;
let zoom = null;
let nodes = [];
let links = [];
let allPaths = [];
let currentHighlightedPath = null;
let searchInProgress = false;

// Autocomplete variables
let searchTimeouts = {};
let selectedActors = {
    actor1: null,
    actor2: null
};

// Initialize the application
document.addEventListener('DOMContentLoaded', function() {
    initializeVisualization();
    setupWebSocket();
    setupAutocomplete();
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
    zoom = d3.zoom()
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

function setupAutocomplete() {
    const actor1Input = document.getElementById('actor1');
    const actor2Input = document.getElementById('actor2');
    
    setupActorInput('actor1', actor1Input);
    setupActorInput('actor2', actor2Input);
    
    // Close dropdowns when clicking outside
    document.addEventListener('click', function(event) {
        if (!event.target.closest('.autocomplete-container')) {
            closeAllDropdowns();
        }
    });
}

function setupActorInput(inputId, inputElement) {
    const dropdownId = `${inputId}-dropdown`;
    const dropdown = document.getElementById(dropdownId);
    let currentHighlighted = -1;
    
    inputElement.addEventListener('input', function(event) {
        const query = event.target.value.trim();
        
        // Clear the search timeout
        if (searchTimeouts[inputId]) {
            clearTimeout(searchTimeouts[inputId]);
        }
        
        // Clear selected actor if input changes
        selectedActors[inputId] = null;
        
        if (query.length < 3) {
            dropdown.classList.remove('show');
            return;
        }
        
        // Show loading
        showLoadingDropdown(dropdown);
        
        // Debounce the search
        searchTimeouts[inputId] = setTimeout(() => {
            searchActors(query, dropdown, inputId);
        }, 300);
    });
    
    inputElement.addEventListener('keydown', function(event) {
        const items = dropdown.querySelectorAll('.autocomplete-item:not(.loading-results):not(.no-results)');
        
        switch(event.key) {
            case 'ArrowDown':
                event.preventDefault();
                currentHighlighted = Math.min(currentHighlighted + 1, items.length - 1);
                updateHighlight(items, currentHighlighted);
                break;
            case 'ArrowUp':
                event.preventDefault();
                currentHighlighted = Math.max(currentHighlighted - 1, -1);
                updateHighlight(items, currentHighlighted);
                break;
            case 'Enter':
                event.preventDefault();
                if (currentHighlighted >= 0 && items[currentHighlighted]) {
                    selectActor(items[currentHighlighted], inputId);
                } else if (inputId === 'actor1') {
                    document.getElementById('actor2').focus();
                } else {
                    findConnections();
                }
                break;
            case 'Escape':
                dropdown.classList.remove('show');
                currentHighlighted = -1;
                break;
        }
    });
    
    inputElement.addEventListener('focus', function() {
        if (dropdown.children.length > 0) {
            dropdown.classList.add('show');
        }
    });
}

function showLoadingDropdown(dropdown) {
    dropdown.innerHTML = '<div class="autocomplete-item loading-results">Searching actors...</div>';
    dropdown.classList.add('show');
}

async function searchActors(query, dropdown, inputId) {
    try {
        const response = await fetch(`/search_actors?query=${encodeURIComponent(query)}`);
        const data = await response.json();
        
        displaySearchResults(data.results, dropdown, inputId);
    } catch (error) {
        console.error('Error searching actors:', error);
        dropdown.innerHTML = '<div class="autocomplete-item no-results">Error searching actors</div>';
        dropdown.classList.add('show');
    }
}

function displaySearchResults(results, dropdown, inputId) {
    dropdown.innerHTML = '';
    
    if (results.length === 0) {
        dropdown.innerHTML = '<div class="autocomplete-item no-results">No actors found</div>';
        dropdown.classList.add('show');
        return;
    }
    
    results.forEach(actor => {
        const item = document.createElement('div');
        item.className = 'autocomplete-item';
        item.onclick = () => selectActor(item, inputId);
        
        const avatar = actor.profile_path 
            ? `<img src="https://image.tmdb.org/t/p/w92${actor.profile_path}" alt="${actor.name}" class="actor-avatar">`
            : '<div class="actor-avatar"></div>';
        
        item.innerHTML = `
            ${avatar}
            <div class="actor-info">
                <div class="actor-name">${actor.name}</div>
                <div class="actor-popularity">Popularity: ${Math.round(actor.popularity)}</div>
            </div>
        `;
        
        // Store actor data for selection
        item.dataset.actorId = actor.id;
        item.dataset.actorName = actor.name;
        
        dropdown.appendChild(item);
    });
    
    dropdown.classList.add('show');
}

function updateHighlight(items, highlightedIndex) {
    items.forEach((item, index) => {
        if (index === highlightedIndex) {
            item.classList.add('highlighted');
        } else {
            item.classList.remove('highlighted');
        }
    });
}

function selectActor(item, inputId) {
    const actorId = item.dataset.actorId;
    const actorName = item.dataset.actorName;
    
    // Set the input value
    document.getElementById(inputId).value = actorName;
    
    // Store selected actor
    selectedActors[inputId] = {
        id: parseInt(actorId),
        name: actorName
    };
    
    // Hide dropdown
    document.getElementById(`${inputId}-dropdown`).classList.remove('show');
    
    // Focus next input or start search
    if (inputId === 'actor1') {
        document.getElementById('actor2').focus();
    } else if (selectedActors.actor1 && selectedActors.actor2) {
        // Both actors selected, could auto-start search here if desired
    }
}

function closeAllDropdowns() {
    document.querySelectorAll('.autocomplete-dropdown').forEach(dropdown => {
        dropdown.classList.remove('show');
    });
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
            searchInProgress = false;
            hideProgress();
            updateStatus(`Found ${data.paths.length} connection path(s)!`, 'success');
            // Load the complete graph at once
            nodes = data.nodes;
            links = data.edges;
            allPaths = data.paths;
            updateVisualization();
            populatePathDropdown();
            populatePathList();
            break;
            
        case 'no_connection':
            searchInProgress = false;
            hideProgress();
            updateStatus(data.message, 'error');
            break;
            
        case 'error':
            searchInProgress = false;
            hideProgress();
            updateStatus(`Error: ${data.error}`, 'error');
            break;
    }
}

function findConnections() {
    // Get actor names - prefer selected actors from autocomplete, fallback to input text
    const actor1 = selectedActors.actor1 ? selectedActors.actor1.name : document.getElementById('actor1').value.trim();
    const actor2 = selectedActors.actor2 ? selectedActors.actor2.name : document.getElementById('actor2').value.trim();
    const maxDepth = parseInt(document.getElementById('searchDepth').value);
    
    if (!actor1 || !actor2) {
        updateStatus('Please enter both actor names', 'error');
        return;
    }
    
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        updateStatus('Not connected to server', 'error');
        return;
    }
    
    searchInProgress = true;
    updateStatus('Starting search...', 'loading');
    showProgress();
    document.getElementById('searchBtn').disabled = true;
    document.getElementById('pathSelector').style.display = 'none';
    document.getElementById('pathListContainer').style.display = 'none';
    
    const message = {
        type: 'find_connections',
        actor1: actor1,
        actor2: actor2,
        max_depth: maxDepth
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
    searchInProgress = false;
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
    
    // Clear selected actors
    selectedActors = {
        actor1: null,
        actor2: null
    };
    
    g.selectAll('.link').remove();
    g.selectAll('.node').remove();
    g.selectAll('.node-label').remove();
    
    document.getElementById('pathDropdown').innerHTML = '<option value="">Select a path to highlight</option>';
    document.getElementById('pathSelector').style.display = 'none';
    document.getElementById('pathListContainer').style.display = 'none';
    document.getElementById('searchBtn').disabled = false;
    searchInProgress = false;
    
    // Close autocomplete dropdowns
    closeAllDropdowns();
}

function populatePathList() {
    const pathListContainer = document.getElementById('pathListContainer');
    const pathList = document.getElementById('pathList');
    
    if (allPaths.length === 0) {
        pathListContainer.style.display = 'none';
        return;
    }
    
    // Sort paths by degree (length)
    const sortedPaths = [...allPaths].sort((a, b) => a.length - b.length);
    
    pathList.innerHTML = '';
    
    sortedPaths.forEach((path, index) => {
        const pathItem = document.createElement('div');
        pathItem.className = 'path-item';
        pathItem.onclick = () => selectPathFromList(index, pathItem);
        
        // Calculate degree
        const degree = Math.floor((path.length - 1) / 2);
        
        // Create degree label
        const degreeDiv = document.createElement('div');
        degreeDiv.className = 'path-degree';
        degreeDiv.textContent = `${degree} Degree${degree !== 1 ? 's' : ''} of Separation`;
        pathItem.appendChild(degreeDiv);
        
        // Create route display
        const routeDiv = document.createElement('div');
        routeDiv.className = 'path-route';
        
        const routeHTML = path.map((nodeId, i) => {
            const node = nodes.find(n => n.id === nodeId);
            if (!node) return `Unknown (${nodeId})`;
            
            const isActor = i % 2 === 0;
            const className = isActor ? 'path-actor' : 'path-movie';
            return `<span class="${className}">${node.name}</span>`;
        }).join('<span class="path-arrow">→</span>');
        
        routeDiv.innerHTML = routeHTML;
        pathItem.appendChild(routeDiv);
        pathList.appendChild(pathItem);
    });
    
    pathListContainer.style.display = 'block';
}

function selectPathFromList(pathIndex, pathElement) {
    // Remove previous selection
    document.querySelectorAll('.path-item').forEach(item => {
        item.classList.remove('selected');
    });
    
    // Add selection to clicked item
    pathElement.classList.add('selected');
    
    // Update dropdown to match
    const sortedPaths = [...allPaths].sort((a, b) => a.length - b.length);
    const originalIndex = allPaths.indexOf(sortedPaths[pathIndex]);
    
    document.getElementById('pathDropdown').value = originalIndex;
    
    // Highlight the path
    highlightPathByIndex(originalIndex);
}

function highlightPathByIndex(pathIndex) {
    // Clear previous highlights
    g.selectAll('.node').classed('highlighted', false);
    g.selectAll('.link').classed('highlighted', false);
    g.selectAll('.node-label').classed('highlighted', false);
    
    if (pathIndex === '' || pathIndex < 0) {
        currentHighlightedPath = null;
        return;
    }
    
    const path = allPaths[pathIndex];
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

function updateVisualization() {
    // Update simulation
    simulation.nodes(nodes);
    simulation.force('link').links(links);
    
    // Update links with proper selection pattern
    const linkSelection = g.selectAll('.link')
        .data(links, d => `${d.source.id || d.source}-${d.target.id || d.target}`);
    
    linkSelection.enter()
        .append('line')
        .attr('class', 'link');
    
    linkSelection.exit().remove();
    
    // Update nodes with proper selection pattern
    const nodeSelection = g.selectAll('.node')
        .data(nodes, d => d.id);
    
    nodeSelection.enter()
        .append('circle')
        .attr('class', d => `node ${d.type.replace('_', '-')}`)
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
    
    nodeSelection.exit().remove();
    
    // Update labels with full names (no truncation)
    const labelSelection = g.selectAll('.node-label')
        .data(nodes, d => d.id);
    
    labelSelection.enter()
        .append('text')
        .attr('class', 'node-label')
        .text(d => d.name);  // Show full name
    
    labelSelection.exit().remove();
    
    // Restart simulation with higher alpha for better stability
    simulation.alpha(0.5).restart();
    
    // Clear any existing tick handlers and set a new one
    simulation.on('tick', null);
    simulation.on('tick', ticked);
}

function ticked() {
    // Update link positions
    g.selectAll('.link')
        .attr('x1', d => {
            const source = typeof d.source === 'object' ? d.source : nodes.find(n => n.id === d.source);
            return source ? source.x : 0;
        })
        .attr('y1', d => {
            const source = typeof d.source === 'object' ? d.source : nodes.find(n => n.id === d.source);
            return source ? source.y : 0;
        })
        .attr('x2', d => {
            const target = typeof d.target === 'object' ? d.target : nodes.find(n => n.id === d.target);
            return target ? target.x : 0;
        })
        .attr('y2', d => {
            const target = typeof d.target === 'object' ? d.target : nodes.find(n => n.id === d.target);
            return target ? target.y : 0;
        });
    
    // Update node positions
    g.selectAll('.node')
        .attr('cx', d => d.x)
        .attr('cy', d => d.y);
    
    // Update label positions
    g.selectAll('.node-label')
        .attr('x', d => d.x)
        .attr('y', d => d.y + 25);
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

// Fit to screen function
function fitToScreen() {
    if (nodes.length === 0) return;
    
    const containerRect = d3.select('.visualization-container').node().getBoundingClientRect();
    const padding = 50;
    
    // Calculate bounds of all nodes
    const xExtent = d3.extent(nodes, d => d.x);
    const yExtent = d3.extent(nodes, d => d.y);
    
    const width = xExtent[1] - xExtent[0];
    const height = yExtent[1] - yExtent[0];
    
    if (width === 0 || height === 0) return;
    
    // Calculate scale to fit all nodes with padding
    const scale = Math.min(
        (containerRect.width - padding * 2) / width,
        (containerRect.height - padding * 2) / height
    );
    
    // Calculate center point
    const centerX = (xExtent[0] + xExtent[1]) / 2;
    const centerY = (yExtent[0] + yExtent[1]) / 2;
    
    // Calculate transform to center the graph
    const translateX = containerRect.width / 2 - scale * centerX;
    const translateY = containerRect.height / 2 - scale * centerY;
    
    // Apply the transform with animation
    svg.transition()
        .duration(750)
        .call(
            zoom.transform,
            d3.zoomIdentity.translate(translateX, translateY).scale(scale)
        );
}

// Save as image function
function saveAsImage() {
    if (nodes.length === 0) {
        alert('No visualization to save. Please find connections first.');
        return;
    }
    
    // Disable the button temporarily
    const saveBtn = document.getElementById('saveImageBtn');
    const originalText = saveBtn.textContent;
    saveBtn.disabled = true;
    saveBtn.textContent = '💾 Saving...';
    
    try {
        // Create a new SVG element for export
        const svgElement = document.getElementById('graph');
        const svgRect = svgElement.getBoundingClientRect();
        
        // Clone the SVG
        const clonedSvg = svgElement.cloneNode(true);
        
        // Set explicit dimensions and background
        clonedSvg.setAttribute('width', svgRect.width);
        clonedSvg.setAttribute('height', svgRect.height);
        clonedSvg.style.backgroundColor = 'white';
        
        // Add CSS styles inline for better compatibility
        const styleSheet = document.createElement('style');
        styleSheet.textContent = `
            .node.search-actor { fill: #e74c3c; stroke: #fff; stroke-width: 2px; }
            .node.movie { fill: #3498db; stroke: #fff; stroke-width: 2px; }
            .node.cast-member { fill: #2ecc71; stroke: #fff; stroke-width: 2px; }
            .node.highlighted { stroke: #f39c12; stroke-width: 4px; fill: #f39c12; }
            .link { stroke: #95a5a6; stroke-width: 2px; stroke-opacity: 0.6; }
            .link.highlighted { stroke: #f39c12; stroke-width: 4px; stroke-opacity: 1; }
            .node-label { font-family: Arial, sans-serif; font-size: 11px; fill: #2c3e50; text-anchor: middle; }
            .node-label.highlighted { font-weight: bold; font-size: 12px; fill: #f39c12; }
        `;
        clonedSvg.insertBefore(styleSheet, clonedSvg.firstChild);
        
        // Add watermark to the SVG
        const watermark = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        watermark.setAttribute('x', svgRect.width - 10);
        watermark.setAttribute('y', svgRect.height - 10);
        watermark.setAttribute('text-anchor', 'end');
        watermark.setAttribute('font-family', 'Arial, sans-serif');
        watermark.setAttribute('font-size', '12');
        watermark.setAttribute('fill', '#999');
        watermark.setAttribute('opacity', '0.7');
        watermark.textContent = 'actors.fromthewestmeadow.com';
        clonedSvg.appendChild(watermark);
        
        // Create a temporary container
        const tempContainer = document.createElement('div');
        tempContainer.style.position = 'absolute';
        tempContainer.style.left = '-9999px';
        tempContainer.appendChild(clonedSvg);
        document.body.appendChild(tempContainer);
        
        // Convert SVG to canvas
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        
        // Set high resolution for better quality
        const scale = 2;
        canvas.width = svgRect.width * scale;
        canvas.height = svgRect.height * scale;
        ctx.scale(scale, scale);
        
        // Set white background
        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, svgRect.width, svgRect.height);
        
        // Convert SVG to data URL
        const svgData = new XMLSerializer().serializeToString(clonedSvg);
        const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
        const svgUrl = URL.createObjectURL(svgBlob);
        
        // Load SVG into image
        const img = new Image();
        img.onload = function() {
            // Draw image on canvas
            ctx.drawImage(img, 0, 0);
            
            // Convert canvas to blob and download
            canvas.toBlob(function(blob) {
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.download = `actor-connections-${Date.now()}.png`;
                link.href = url;
                link.click();
                
                // Cleanup
                URL.revokeObjectURL(url);
                URL.revokeObjectURL(svgUrl);
                document.body.removeChild(tempContainer);
                
                // Re-enable button
                saveBtn.disabled = false;
                saveBtn.textContent = originalText;
            }, 'image/png', 1.0);
        };
        
        img.onerror = function() {
            // Fallback: download SVG directly
            const link = document.createElement('a');
            link.download = `actor-connections-${Date.now()}.svg`;
            link.href = svgUrl;
            link.click();
            
            // Cleanup
            URL.revokeObjectURL(svgUrl);
            document.body.removeChild(tempContainer);
            
            // Re-enable button
            saveBtn.disabled = false;
            saveBtn.textContent = originalText;
        };
        
        img.src = svgUrl;
        
    } catch (error) {
        console.error('Error saving image:', error);
        alert('Error saving image. Please try again.');
        
        // Re-enable button
        saveBtn.disabled = false;
        saveBtn.textContent = originalText;
    }
}

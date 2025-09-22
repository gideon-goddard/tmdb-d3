# Actor Connection Finder

A web application that finds connections between actors using The Movie Database (TMDB) API. The app uses a bidirectional breadth-first search algorithm to discover paths between two actors through their movies and co-stars.

## Features

- **Real-time Search**: Uses WebSocket for live updates as connections are discovered
- **Interactive Visualization**: D3.js powered graph with pan, zoom, and drag functionality
- **Multiple Paths**: Finds and displays all possible connection paths
- **Path Highlighting**: Dropdown selector to highlight specific connection paths
- **Responsive Design**: Works on desktop and mobile devices

## Setup

1. **Install Dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

2. **Environment Variables**:
   Make sure your `.env` file contains your TMDB API key:
   ```
   TMDB_API_KEY=your_api_key_here
   ```

3. **Run the Application**:
   ```bash
   python main.py
   ```

4. **Open Browser**:
   Navigate to `http://localhost:8000`

## How to Use

1. Enter the names of two actors in the input fields
2. Click "Find Connections" to start the search
3. Watch as the graph builds in real-time showing actors, movies, and connections
4. Once connections are found, use the dropdown to highlight specific paths
5. Interact with the graph by:
   - **Panning**: Click and drag the background
   - **Zooming**: Use mouse wheel
   - **Moving nodes**: Drag individual nodes around

## Graph Legend

- 🔴 **Red nodes**: Search actors (the two actors you're looking for connections between)
- 🔵 **Blue nodes**: Movies
- 🟢 **Green nodes**: Cast members (other actors found in the search)

## Algorithm

The app uses a **bidirectional breadth-first search**:

1. Starts from both target actors simultaneously
2. Expands outward by finding movies for each actor
3. Then finds cast members for those movies
4. Continues alternating between movies and actors
5. Stops when a connection is found or maximum depth is reached

This approach is more efficient than a single-direction search and finds the shortest paths between actors.

## Technical Stack

- **Backend**: FastAPI (Python)
- **Frontend**: Vanilla JavaScript with D3.js
- **Real-time Communication**: WebSockets
- **Data Source**: The Movie Database (TMDB) API
- **Visualization**: D3.js force-directed graph

## Project Structure

```
tmdb-d3/
├── main.py              # FastAPI backend server
├── requirements.txt     # Python dependencies
├── .env                # Environment variables
├── .gitignore          # Git ignore file
├── static/             # Frontend assets
│   ├── index.html      # Main HTML page
│   ├── styles.css      # CSS styles
│   └── script.js       # JavaScript application logic
└── README.md           # This file
```

## API Endpoints

- `GET /`: Serves the main application
- `WebSocket /ws`: Real-time communication for search updates

## Contributing

Feel free to submit issues and enhancement requests!

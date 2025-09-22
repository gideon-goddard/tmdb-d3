import os
import asyncio
from collections import deque
from typing import List, Dict, Optional, Set, Tuple
import httpx
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
from dotenv import load_dotenv
import json

# Load environment variables
load_dotenv()

app = FastAPI(title="Actor Connection Finder")

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount static files
app.mount("/static", StaticFiles(directory="static"), name="static")

# TMDB API configuration
TMDB_API_KEY = os.getenv("TMDB_API_KEY")
TMDB_BASE_URL = "https://api.themoviedb.org/3"

class TMDBClient:
    def __init__(self):
        self.api_key = TMDB_API_KEY
        self.base_url = TMDB_BASE_URL
        
    async def search_person(self, name: str) -> Optional[Dict]:
        """Search for a person by name"""
        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    f"{self.base_url}/search/person",
                    params={"api_key": self.api_key, "query": name}
                )
                response.raise_for_status()
                data = response.json()
                print(f"Search for '{name}' returned {len(data.get('results', []))} results")
                if data["results"]:
                    return data["results"][0]  # Return first match
                return None
        except Exception as e:
            print(f"Error searching for person '{name}': {e}")
            return None
    
    async def get_person_movies(self, person_id: int) -> List[Dict]:
        """Get movies for a person"""
        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    f"{self.base_url}/person/{person_id}/movie_credits",
                    params={"api_key": self.api_key}
                )
                response.raise_for_status()
                data = response.json()
                movies = data.get("cast", [])
                print(f"Found {len(movies)} movies for person {person_id}")
                return movies
        except Exception as e:
            print(f"Error getting movies for person {person_id}: {e}")
            return []
    
    async def get_movie_cast(self, movie_id: int) -> List[Dict]:
        """Get cast for a movie"""
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{self.base_url}/movie/{movie_id}/credits",
                params={"api_key": self.api_key}
            )
            data = response.json()
            return data.get("cast", [])

class ActorConnectionFinder:
    def __init__(self):
        self.tmdb = TMDBClient()
        self.search_cancelled = False
    
    async def find_connections(self, actor1_name: str, actor2_name: str, max_depth: int, websocket: WebSocket):
        """Find connections between two actors using bidirectional BFS"""
        try:
            self.search_cancelled = False
            print(f"Starting search for connections between '{actor1_name}' and '{actor2_name}' (max depth: {max_depth})")
            
            # Search for actors
            await websocket.send_text(json.dumps({
                "type": "progress",
                "message": "Searching for actors...",
                "stage": "search",
                "progress": 10
            }))
            
            if self.search_cancelled:
                await websocket.send_text(json.dumps({"type": "search_stopped"}))
                return
            
            actor1 = await self.tmdb.search_person(actor1_name)
            actor2 = await self.tmdb.search_person(actor2_name)
            
            if not actor1:
                await websocket.send_text(json.dumps({"error": f"Actor '{actor1_name}' not found"}))
                return
            
            if not actor2:
                await websocket.send_text(json.dumps({"error": f"Actor '{actor2_name}' not found"}))
                return
            
            print(f"Found actors: {actor1['name']} (ID: {actor1['id']}) and {actor2['name']} (ID: {actor2['id']})")
            
            await websocket.send_text(json.dumps({
                "type": "actors_found",
                "actor1": {"id": actor1["id"], "name": actor1["name"]},
                "actor2": {"id": actor2["id"], "name": actor2["name"]}
            }))
            
            # Find all connection paths first
            paths = await self._find_all_paths(actor1, actor2, max_depth, websocket)
            
            if self.search_cancelled:
                await websocket.send_text(json.dumps({"type": "search_stopped"}))
                return
            
            if paths:
                await websocket.send_text(json.dumps({
                    "type": "progress",
                    "message": "Building final graph...",
                    "stage": "building",
                    "progress": 80
                }))
                
                # Build the complete graph for all found paths
                all_nodes = {}
                all_edges = []
                
                # Add search actors
                all_nodes[actor1["id"]] = {"id": actor1["id"], "name": actor1["name"], "type": "search_actor"}
                all_nodes[actor2["id"]] = {"id": actor2["id"], "name": actor2["name"], "type": "search_actor"}
                
                # Build graph from paths
                total_nodes = sum(len(path) for path in paths)
                processed_nodes = 0
                
                for path in paths:
                    for i, node_id in enumerate(path):
                        if self.search_cancelled:
                            await websocket.send_text(json.dumps({"type": "search_stopped"}))
                            return
                            
                        if node_id not in all_nodes:
                            # Determine if this is a movie or actor
                            if i % 2 == 0:  # Even indices are actors, odd are movies
                                # Get actor details
                                actor_details = await self._get_actor_details(node_id)
                                if actor_details:
                                    node_type = "search_actor" if node_id in [actor1["id"], actor2["id"]] else "cast_member"
                                    all_nodes[node_id] = {"id": node_id, "name": actor_details["name"], "type": node_type}
                            else:
                                # Get movie details
                                movie_details = await self._get_movie_details(node_id)
                                if movie_details:
                                    all_nodes[node_id] = {"id": node_id, "name": movie_details["title"], "type": "movie"}
                        
                        # Add edges
                        if i < len(path) - 1:
                            edge = {"source": path[i], "target": path[i + 1]}
                            if edge not in all_edges:
                                all_edges.append(edge)
                        
                        processed_nodes += 1
                        if processed_nodes % 5 == 0:  # Update progress every 5 nodes
                            progress = 80 + (processed_nodes / total_nodes) * 15
                            await websocket.send_text(json.dumps({
                                "type": "progress",
                                "message": f"Processing node {processed_nodes}/{total_nodes}",
                                "stage": "building",
                                "progress": min(95, progress)
                            }))
                
                await websocket.send_text(json.dumps({
                    "type": "progress",
                    "message": "Complete!",
                    "stage": "complete",
                    "progress": 100
                }))
                
                # Send the complete graph at once
                await websocket.send_text(json.dumps({
                    "type": "complete_graph",
                    "nodes": list(all_nodes.values()),
                    "edges": all_edges,
                    "paths": paths
                }))
            else:
                await websocket.send_text(json.dumps({
                    "type": "no_connection",
                    "message": "No connection found within search depth"
                }))
                
        except Exception as e:
            print(f"Error in find_connections: {e}")
            await websocket.send_text(json.dumps({"error": str(e)}))
    
    async def _find_all_paths(self, actor1, actor2, max_depth, websocket):
        """Find all connection paths between two actors"""
        await websocket.send_text(json.dumps({
            "type": "progress",
            "message": "Getting actor filmographies...",
            "stage": "movies",
            "progress": 20
        }))
        
        if self.search_cancelled:
            return []
        
        # Check for direct movie connections first
        actor1_movies = await self.tmdb.get_person_movies(actor1["id"])
        actor2_movies = await self.tmdb.get_person_movies(actor2["id"])
        
        await websocket.send_text(json.dumps({
            "type": "progress",
            "message": "Checking for direct connections...",
            "stage": "direct",
            "progress": 40
        }))
        
        # Look for common movies (direct connection)
        actor1_movie_ids = {movie["id"] for movie in actor1_movies}
        actor2_movie_ids = {movie["id"] for movie in actor2_movies}
        common_movies = actor1_movie_ids.intersection(actor2_movie_ids)
        
        all_paths = []
        
        # Add direct connections through shared movies (degree 1)
        for movie_id in list(common_movies)[:10]:  # Increased limit
            all_paths.append([actor1["id"], movie_id, actor2["id"]])
        
        if all_paths:
            await websocket.send_text(json.dumps({
                "type": "progress",
                "message": f"Found {len(all_paths)} direct connection(s)!",
                "stage": "found",
                "progress": 50
            }))
        
        # Continue searching for deeper connections if max_depth > 1
        if max_depth > 1 and not self.search_cancelled:
            await websocket.send_text(json.dumps({
                "type": "progress",
                "message": "Searching for indirect connections...",
                "stage": "bfs",
                "progress": 50
            }))
            
            deeper_paths = await self._comprehensive_bfs_search(actor1, actor2, max_depth, websocket)
            if not self.search_cancelled:
                all_paths.extend(deeper_paths)
        
        # Sort paths by degree (length)
        all_paths.sort(key=len)
        
        return all_paths
    
    async def _comprehensive_bfs_search(self, actor1, actor2, max_depth, websocket):
        """Comprehensive bidirectional BFS search for multiple connection paths"""
        queue1 = deque([(actor1["id"], "actor", [actor1["id"]])])
        queue2 = deque([(actor2["id"], "actor", [actor2["id"]])])
        
        visited1 = {actor1["id"]: [actor1["id"]]}
        visited2 = {actor2["id"]: [actor2["id"]]}
        
        all_paths = []
        current_depth = 0
        
        while (queue1 or queue2) and current_depth < max_depth and not self.search_cancelled:
            current_depth += 1
            
            await websocket.send_text(json.dumps({
                "type": "progress",
                "message": f"Searching depth {current_depth}/{max_depth}...",
                "stage": "bfs",
                "progress": 50 + (current_depth / max_depth) * 20,
                "depth": current_depth,
                "queue_size": len(queue1) + len(queue2)
            }))
            
            # Process one level from each side
            if queue1:
                await self._process_comprehensive_bfs_level(queue1, visited1, visited2, all_paths, "forward", websocket)
            
            if queue2:
                await self._process_comprehensive_bfs_level(queue2, visited2, visited1, all_paths, "backward", websocket)
            
            # Continue searching even after finding paths to get all possible connections
            if len(all_paths) > 20:  # Limit total paths to prevent overwhelming
                break
        
        if all_paths:
            await websocket.send_text(json.dumps({
                "type": "progress",
                "message": f"Found {len(all_paths)} additional connection(s)!",
                "stage": "found",
                "progress": 70
            }))
        
        return all_paths
    
    async def _process_comprehensive_bfs_level(self, queue, visited_self, visited_other, all_paths, direction, websocket):
        """Process one BFS level for comprehensive search"""
        level_size = len(queue)
        processed_in_level = 0
        
        for _ in range(level_size):
            if not queue or self.search_cancelled:
                break
                
            current_id, current_type, path = queue.popleft()
            processed_in_level += 1
            
            # Send progress update occasionally
            if processed_in_level % 10 == 0:
                await websocket.send_text(json.dumps({
                    "type": "progress",
                    "message": f"Processing {current_type} {processed_in_level}/{level_size}",
                    "stage": "bfs",
                    "progress": 50 + (processed_in_level / level_size) * 5,
                    "current_type": current_type,
                    "processed": processed_in_level,
                    "total_in_level": level_size
                }))
            
            if current_type == "actor":
                movies = await self.tmdb.get_person_movies(current_id)
                for movie in movies:
                    movie_id = movie["id"]
                    
                    if movie_id not in visited_self:
                        visited_self[movie_id] = path + [movie_id]
                        queue.append((movie_id, "movie", path + [movie_id]))
                        
                        # Check for connection and add to all_paths (don't return immediately)
                        if movie_id in visited_other:
                            connection_path = self._construct_path(visited_self[movie_id], visited_other[movie_id], direction)
                            if connection_path not in all_paths:
                                all_paths.append(connection_path)
            
            elif current_type == "movie":
                cast = await self.tmdb.get_movie_cast(current_id)
                for actor in cast:
                    actor_id = actor["id"]
                    
                    if actor_id not in visited_self:
                        visited_self[actor_id] = path + [actor_id]
                        queue.append((actor_id, "actor", path + [actor_id]))
                        
                        # Check for connection and add to all_paths (don't return immediately)
                        if actor_id in visited_other:
                            connection_path = self._construct_path(visited_self[actor_id], visited_other[actor_id], direction)
                            if connection_path not in all_paths:
                                all_paths.append(connection_path)

    async def _process_bfs_level(self, queue, visited_self, visited_other, paths, direction, websocket):
        """Process one BFS level"""
        level_size = len(queue)
        processed_in_level = 0
        
        for _ in range(level_size):
            if not queue or paths or self.search_cancelled:  # Stop if we found paths or search cancelled
                break
                
            current_id, current_type, path = queue.popleft()
            processed_in_level += 1
            
            # Send progress update
            await websocket.send_text(json.dumps({
                "type": "progress",
                "message": f"Processing {current_type} {processed_in_level}/{level_size}",
                "stage": "bfs",
                "progress": 50 + (processed_in_level / level_size) * 5,
                "current_type": current_type,
                "processed": processed_in_level,
                "total_in_level": level_size
            }))
            
            if current_type == "actor":
                movies = await self.tmdb.get_person_movies(current_id)
                for movie in movies:
                    movie_id = movie["id"]
                    
                    if movie_id not in visited_self:
                        visited_self[movie_id] = path + [movie_id]
                        queue.append((movie_id, "movie", path + [movie_id]))
                        
                        # Check for connection
                        if movie_id in visited_other:
                            connection_path = self._construct_path(visited_self[movie_id], visited_other[movie_id], direction)
                            paths.append(connection_path)
                            return
            
            elif current_type == "movie":
                cast = await self.tmdb.get_movie_cast(current_id)
                for actor in cast:
                    actor_id = actor["id"]
                    
                    if actor_id not in visited_self:
                        visited_self[actor_id] = path + [actor_id]
                        queue.append((actor_id, "actor", path + [actor_id]))
                        
                        # Check for connection
                        if actor_id in visited_other:
                            connection_path = self._construct_path(visited_self[actor_id], visited_other[actor_id], direction)
                            paths.append(connection_path)
                            return
    
    async def _get_actor_details(self, actor_id):
        """Get actor details by ID"""
        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    f"{self.tmdb.base_url}/person/{actor_id}",
                    params={"api_key": self.tmdb.api_key}
                )
                response.raise_for_status()
                return response.json()
        except Exception as e:
            print(f"Error getting actor details for {actor_id}: {e}")
            return None
    
    async def _get_movie_details(self, movie_id):
        """Get movie details by ID"""
        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    f"{self.tmdb.base_url}/movie/{movie_id}",
                    params={"api_key": self.tmdb.api_key}
                )
                response.raise_for_status()
                return response.json()
        except Exception as e:
            print(f"Error getting movie details for {movie_id}: {e}")
            return None
    
    def _construct_path(self, path1, path2, direction):
        """Construct the full path when connection is found"""
        if direction == "forward":
            return path1 + path2[::-1][1:]
        else:
            return path2 + path1[::-1][1:]
    
    def cancel_search(self):
        """Cancel the current search"""
        self.search_cancelled = True

# Global connection finder instance
connection_finder = ActorConnectionFinder()

@app.get("/")
async def read_root():
    """Serve the main HTML page"""
    with open("static/index.html", "r") as f:
        html_content = f.read()
    return HTMLResponse(content=html_content)

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket endpoint for real-time communication"""
    await websocket.accept()
    print("WebSocket connection accepted")
    
    try:
        while True:
            data = await websocket.receive_text()
            print(f"Received WebSocket message: {data}")
            message = json.loads(data)
            
            if message["type"] == "find_connections":
                actor1 = message["actor1"]
                actor2 = message["actor2"]
                max_depth = message.get("max_depth", 2)  # Default to depth 2
                print(f"Processing connection request: {actor1} -> {actor2} (depth: {max_depth})")
                
                await connection_finder.find_connections(actor1, actor2, max_depth, websocket)
                
            elif message["type"] == "stop_search":
                print("Received stop search request")
                connection_finder.search_cancelled = True
                await websocket.send_text(json.dumps({"type": "search_stopped"}))
                
    except WebSocketDisconnect:
        print("WebSocket disconnected")
    except Exception as e:
        print(f"WebSocket error: {e}")
        await websocket.send_text(json.dumps({"error": f"Server error: {str(e)}"}))
        connection_finder.search_cancelled = True

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

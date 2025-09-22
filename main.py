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
                # Only include cast movies for cleaner connections
                movies = data.get("cast", [])
                print(f"Found {len(movies)} movies for person {person_id}")
                return movies
        except Exception as e:
            print(f"Error getting movies for person {person_id}: {e}")
            return []
    
    async def get_movie_cast(self, movie_id: int) -> List[Dict]:
        """Get cast for a movie"""
        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    f"{self.base_url}/movie/{movie_id}/credits",
                    params={"api_key": self.api_key}
                )
                response.raise_for_status()
                data = response.json()
                # Only include cast for cleaner, more understandable connections
                people = data.get("cast", [])
                print(f"Found {len(people)} cast members for movie {movie_id}")
                return people
        except Exception as e:
            print(f"Error getting cast for movie {movie_id}: {e}")
            return []

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
            
            if self.search_cancelled:
                await websocket.send_text(json.dumps({"type": "search_stopped"}))
                return
            
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
                
                if self.search_cancelled:
                    await websocket.send_text(json.dumps({"type": "search_stopped"}))
                    return
                
                # Build the graph from the found paths only
                all_nodes = {}
                all_edges = []
                
                # Process each path to build nodes and edges
                total_paths = len(paths)
                processed_paths = 0
                
                for path in paths:
                    if self.search_cancelled:
                        await websocket.send_text(json.dumps({"type": "search_stopped"}))
                        return
                        
                    for i, node_id in enumerate(path):
                        # Add node if not already added
                        if node_id not in all_nodes:
                            # Determine if this is a movie or actor based on position in path
                            if i % 2 == 0:  # Even indices are actors
                                # Get actor details
                                actor_details = await self._get_actor_details(node_id)
                                if actor_details:
                                    # Determine node type
                                    if node_id == actor1["id"] or node_id == actor2["id"]:
                                        node_type = "search_actor"
                                    else:
                                        node_type = "cast_member"
                                    all_nodes[node_id] = {
                                        "id": node_id, 
                                        "name": actor_details["name"], 
                                        "type": node_type
                                    }
                            else:  # Odd indices are movies
                                # Get movie details
                                movie_details = await self._get_movie_details(node_id)
                                if movie_details:
                                    all_nodes[node_id] = {
                                        "id": node_id, 
                                        "name": movie_details["title"], 
                                        "type": "movie"
                                    }
                        
                        # Add edge between consecutive nodes in the path
                        if i < len(path) - 1:
                            source_id = path[i]
                            target_id = path[i + 1]
                            edge = {"source": source_id, "target": target_id}
                            
                            # Check if edge already exists (to avoid duplicates)
                            edge_exists = any(
                                (e["source"] == source_id and e["target"] == target_id) or
                                (e["source"] == target_id and e["target"] == source_id)
                                for e in all_edges
                            )
                            
                            if not edge_exists:
                                all_edges.append(edge)
                    
                    processed_paths += 1
                    if processed_paths % 5 == 0:  # Update progress every 5 paths
                        progress = 80 + (processed_paths / total_paths) * 15
                        await websocket.send_text(json.dumps({
                            "type": "progress",
                            "message": f"Processing path {processed_paths}/{total_paths}",
                            "stage": "building",
                            "progress": min(95, progress)
                        }))
                
                await websocket.send_text(json.dumps({
                    "type": "progress",
                    "message": "Complete!",
                    "stage": "complete",
                    "progress": 100
                }))
                
                if self.search_cancelled:
                    await websocket.send_text(json.dumps({"type": "search_stopped"}))
                    return
                
                # Send the complete graph with only path-related nodes and edges
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
        
        if self.search_cancelled:
            return []
        
        # Look for common movies (direct connection)
        actor1_movie_ids = {movie["id"] for movie in actor1_movies}
        actor2_movie_ids = {movie["id"] for movie in actor2_movies}
        common_movies = actor1_movie_ids.intersection(actor2_movie_ids)
        
        all_paths = []
        
        # Add direct connections through shared movies (degree 1)
        common_movies_list = list(common_movies)  # Remove limit - get all direct connections
        for movie_id in common_movies_list:
            all_paths.append([actor1["id"], movie_id, actor2["id"]])
        
        if all_paths:
            await websocket.send_text(json.dumps({
                "type": "progress",
                "message": f"Found {len(all_paths)} direct connection(s)!",
                "stage": "found",
                "progress": 50
            }))
            if self.search_cancelled:
                return []
        
        # Continue searching for deeper connections if max_depth > 1
        if max_depth > 1 and not self.search_cancelled:
            await websocket.send_text(json.dumps({
                "type": "progress",
                "message": "Searching for indirect connections...",
                "stage": "bfs",
                "progress": 50
            }))
            
            if self.search_cancelled:
                return self._filter_duplicate_movies(all_paths)
            
            deeper_paths = await self._comprehensive_bfs_search(actor1, actor2, max_depth, websocket)
            if not self.search_cancelled:
                all_paths.extend(deeper_paths)
        
        # Sort paths by degree (length)
        all_paths.sort(key=len)
        
        # Filter out duplicate movies to prevent star formations
        filtered_paths = self._filter_duplicate_movies(all_paths)
        
        print(f"Found {len(all_paths)} total paths, filtered to {len(filtered_paths)} unique paths")
        for i, path in enumerate(filtered_paths):
            print(f"Path {i+1}: {path}")
        
        return filtered_paths
    
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
                if self.search_cancelled:
                    break
            
            if queue2:
                await self._process_comprehensive_bfs_level(queue2, visited2, visited1, all_paths, "backward", websocket)
                if self.search_cancelled:
                    break
            
            # Continue searching even after finding paths to get all possible connections
            if len(all_paths) > 50:  # Increased limit to allow more comprehensive results
                break
        
        if all_paths:
            await websocket.send_text(json.dumps({
                "type": "progress",
                "message": f"Found {len(all_paths)} additional connection(s)!",
                "stage": "found",
                "progress": 70
            }))
        
        return all_paths
    
    def _filter_duplicate_movies(self, all_paths):
        """Filter paths to ensure no movie appears in more than one path to prevent star formations"""
        if not all_paths:
            return all_paths
        # Only keep paths with all unique node IDs
        valid_paths = []
        for path in all_paths:
            if self._validate_path(path) and len(set(path)) == len(path):
                valid_paths.append(path)
            else:
                print(f"Invalid or non-unique path filtered out: {path}")
        return valid_paths
    
    def _validate_path(self, path):
        """Validate that a path alternates between actors and movies correctly"""
        if len(path) < 3:
            return False
        
        # Path should alternate: actor -> movie -> actor -> movie -> ...
        for i in range(len(path)):
            if i % 2 == 0:  # Should be actor
                # For now, just check it's not None/empty
                if not path[i]:
                    return False
            else:  # Should be movie
                if not path[i]:
                    return False
        
        # First and last should be actors
        return len(path) % 2 == 1
    
    def _calculate_path_preference_score(self, path):
        """Calculate a preference score for path selection (lower is better)"""
        # Prefer paths with fewer total nodes (simpler connections)
        return len(path)
    
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
                if self.search_cancelled:
                    return
            
            if current_type == "actor":
                movies = await self.tmdb.get_person_movies(current_id)
                for movie in movies:  # Process all movies without limit
                    if self.search_cancelled:
                        return
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
                for actor in cast:  # Process all cast members without limit
                    if self.search_cancelled:
                        return
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
                for movie in movies:  # Process all movies without limit
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
                for actor in cast:  # Process all cast members without limit
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

@app.get("/search_actors")
async def search_actors(query: str):
    """Search for actors by name for autocomplete"""
    if len(query) < 3:
        return {"results": []}
    
    try:
        tmdb = TMDBClient()
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{tmdb.base_url}/search/person",
                params={"api_key": tmdb.api_key, "query": query}
            )
            response.raise_for_status()
            data = response.json()
            
            # Filter to only include people with known_for_department as Acting
            actors = []
            for person in data.get("results", [])[:20]:  # Increased from 10 to 20 results
                if person.get("known_for_department") == "Acting" and person.get("popularity", 0) > 0.5:  # Lowered popularity threshold
                    actors.append({
                        "id": person["id"],
                        "name": person["name"],
                        "profile_path": person.get("profile_path"),
                        "popularity": person.get("popularity", 0)
                    })
            
            # Sort by popularity (descending)
            actors.sort(key=lambda x: x["popularity"], reverse=True)
            
            return {"results": actors}
            
    except Exception as e:
        print(f"Error searching for actors with query '{query}': {e}")
        return {"results": []}

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
                
    except WebSocketDisconnect:
        print("WebSocket disconnected")
    except Exception as e:
        print(f"WebSocket error: {e}")
        await websocket.send_text(json.dumps({"error": f"Server error: {str(e)}"}))
        connection_finder.search_cancelled = True

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

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
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{self.base_url}/search/person",
                params={"api_key": self.api_key, "query": name}
            )
            data = response.json()
            if data["results"]:
                return data["results"][0]  # Return first match
            return None
    
    async def get_person_movies(self, person_id: int) -> List[Dict]:
        """Get movies for a person"""
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{self.base_url}/person/{person_id}/movie_credits",
                params={"api_key": self.api_key}
            )
            data = response.json()
            return data.get("cast", [])
    
    async def get_movie_cast(self, movie_id: int) -> List[Dict]:
        """Get cast for a movie"""
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{self.base_url}/movie/{movie_id}/credits",
                params={"api_key": self.api_key}
            )
            data = response.json()
            return data.get("cast", [])[:20]  # Limit to top 20 cast members

class ActorConnectionFinder:
    def __init__(self):
        self.tmdb = TMDBClient()
    
    async def find_connections(self, actor1_name: str, actor2_name: str, websocket: WebSocket):
        """Find connections between two actors using bidirectional BFS"""
        try:
            # Search for actors
            actor1 = await self.tmdb.search_person(actor1_name)
            actor2 = await self.tmdb.search_person(actor2_name)
            
            if not actor1:
                await websocket.send_text(json.dumps({"error": f"Actor '{actor1_name}' not found"}))
                return
            
            if not actor2:
                await websocket.send_text(json.dumps({"error": f"Actor '{actor2_name}' not found"}))
                return
            
            await websocket.send_text(json.dumps({
                "type": "actors_found",
                "actor1": {"id": actor1["id"], "name": actor1["name"]},
                "actor2": {"id": actor2["id"], "name": actor2["name"]}
            }))
            
            # Initialize BFS from both ends
            queue1 = deque([(actor1["id"], "actor", [actor1["id"]])])
            queue2 = deque([(actor2["id"], "actor", [actor2["id"]])])
            
            visited1 = {actor1["id"]: [actor1["id"]]}
            visited2 = {actor2["id"]: [actor2["id"]]}
            
            nodes = {
                actor1["id"]: {"id": actor1["id"], "name": actor1["name"], "type": "search_actor"},
                actor2["id"]: {"id": actor2["id"], "name": actor2["name"], "type": "search_actor"}
            }
            edges = []
            paths = []
            
            max_depth = 3  # Limit search depth
            current_depth = 0
            
            while (queue1 or queue2) and current_depth < max_depth:
                current_depth += 1
                
                # Process queue1 (from actor1)
                if queue1:
                    await self._process_queue(queue1, visited1, visited2, nodes, edges, paths, websocket, "forward")
                
                # Process queue2 (from actor2)
                if queue2:
                    await self._process_queue(queue2, visited2, visited1, nodes, edges, paths, websocket, "backward")
                
                if paths:  # Connection found
                    break
            
            if paths:
                await websocket.send_text(json.dumps({
                    "type": "connections_found",
                    "paths": paths,
                    "nodes": list(nodes.values()),
                    "edges": edges
                }))
            else:
                await websocket.send_text(json.dumps({
                    "type": "no_connection",
                    "message": "No connection found within search depth"
                }))
                
        except Exception as e:
            await websocket.send_text(json.dumps({"error": str(e)}))
    
    async def _process_queue(self, queue, visited_self, visited_other, nodes, edges, paths, websocket, direction):
        """Process one level of BFS queue"""
        level_size = len(queue)
        
        for _ in range(level_size):
            if not queue:
                break
                
            current_id, current_type, path = queue.popleft()
            
            if current_type == "actor":
                # Get movies for this actor
                movies = await self.tmdb.get_person_movies(current_id)
                for movie in movies[:10]:  # Limit to 10 movies
                    movie_id = movie["id"]
                    
                    if movie_id not in nodes:
                        nodes[movie_id] = {
                            "id": movie_id,
                            "name": movie["title"],
                            "type": "movie"
                        }
                        
                        await websocket.send_text(json.dumps({
                            "type": "node_added",
                            "node": nodes[movie_id]
                        }))
                    
                    # Add edge
                    edge = {"source": current_id, "target": movie_id}
                    if edge not in edges:
                        edges.append(edge)
                        await websocket.send_text(json.dumps({
                            "type": "edge_added",
                            "edge": edge
                        }))
                    
                    if movie_id not in visited_self:
                        visited_self[movie_id] = path + [movie_id]
                        queue.append((movie_id, "movie", path + [movie_id]))
                        
                        # Check for connection
                        if movie_id in visited_other:
                            connection_path = self._construct_path(visited_self[movie_id], visited_other[movie_id], direction)
                            paths.append(connection_path)
                            return
            
            elif current_type == "movie":
                # Get cast for this movie
                cast = await self.tmdb.get_movie_cast(current_id)
                for actor in cast:
                    actor_id = actor["id"]
                    
                    if actor_id not in nodes:
                        nodes[actor_id] = {
                            "id": actor_id,
                            "name": actor["name"],
                            "type": "cast_member"
                        }
                        
                        await websocket.send_text(json.dumps({
                            "type": "node_added",
                            "node": nodes[actor_id]
                        }))
                    
                    # Add edge
                    edge = {"source": current_id, "target": actor_id}
                    if edge not in edges:
                        edges.append(edge)
                        await websocket.send_text(json.dumps({
                            "type": "edge_added",
                            "edge": edge
                        }))
                    
                    if actor_id not in visited_self:
                        visited_self[actor_id] = path + [actor_id]
                        queue.append((actor_id, "actor", path + [actor_id]))
                        
                        # Check for connection
                        if actor_id in visited_other:
                            connection_path = self._construct_path(visited_self[actor_id], visited_other[actor_id], direction)
                            paths.append(connection_path)
                            return
    
    def _construct_path(self, path1, path2, direction):
        """Construct the full path when connection is found"""
        if direction == "forward":
            return path1 + path2[::-1][1:]
        else:
            return path2 + path1[::-1][1:]

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
    
    try:
        while True:
            data = await websocket.receive_text()
            message = json.loads(data)
            
            if message["type"] == "find_connections":
                actor1 = message["actor1"]
                actor2 = message["actor2"]
                
                await connection_finder.find_connections(actor1, actor2, websocket)
                
    except WebSocketDisconnect:
        print("WebSocket disconnected")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

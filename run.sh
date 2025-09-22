#!/bin/bash

# Actor Connection Finder - Run Script

echo "🎬 Starting Actor Connection Finder..."

# Check if virtual environment exists
if [ ! -d ".venv" ]; then
    echo "📦 Creating virtual environment..."
    python3 -m venv .venv
fi

# Activate virtual environment
echo "🔧 Activating virtual environment..."
source .venv/bin/activate

# Install dependencies
echo "📚 Installing dependencies..."
pip install -r requirements.txt

# Check if .env file exists
if [ ! -f ".env" ]; then
    echo "⚠️  Warning: .env file not found!"
    echo "Please create a .env file with your TMDB API key:"
    echo "TMDB_API_KEY=your_api_key_here"
    exit 1
fi

# Start the server
echo "🚀 Starting FastAPI server..."
echo "📱 Open your browser to: http://localhost:8000"
python main.py

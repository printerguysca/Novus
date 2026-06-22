#!/bin/bash
# Double-click this file to launch Soho Blinds WMS
cd "$(dirname "$0")"

echo "================================="
echo "  Soho Blinds WMS"
echo "================================="

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
fi

echo ""
echo "Starting server..."
echo "Open your browser to: http://localhost:3000"
echo ""
node server.js

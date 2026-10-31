#!/bin/bash

# Auto-start the Mirage Cloud Panel server in the background if not already running.
# This script is sourced from ~/.bashrc on sandbox shell open.

if ! pgrep -f "server/index.js" > /dev/null 2>&1; then
  # The port is published out of the sandbox, so listen on every interface.
  HOST="${HOST:-0.0.0.0}" nohup mirage start --port 3001 > /tmp/mirage-ui.log 2>&1 &
  disown

  echo ""
  echo "  Mirage Cloud Panel is starting on port 3001..."
  echo ""
  echo "  Forward the port from another terminal:"
  echo "    sbx ports <sandbox-name> --publish 3001:3001"
  echo ""
  echo "  Then open: http://localhost:3001"
  echo ""
fi

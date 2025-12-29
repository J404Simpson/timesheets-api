#!/bin/bash

# Exit on error
set -e

echo "Preparing deployment..."

# Copy pre-built application files to the site
echo "Copying built files to /home/site/wwwroot..."
cp -R ./dist/* /home/site/wwwroot/

echo "Deployment complete."
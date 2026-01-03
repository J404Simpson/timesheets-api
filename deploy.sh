#!/bin/bash

# Exit on error
set -e

echo "Preparing deployment..."

# Ensure the destination directory exists
echo "Cleaning the existing wwwroot directory..."
rm -rf /home/site/wwwroot/*

# Copy the built application files
echo "Copying built files to /home/site/wwwroot..."
cp -R ./dist/* /home/site/wwwroot/

# Copy additional runtime files (if needed)
echo "Copying package.json and lock file..."
cp ./package.json /home/site/wwwroot/
cp ./package-lock.json /home/site/wwwroot/

# Copy Prisma schema files
echo "Copying Prisma files..."
cp -R ./prisma /home/site/wwwroot/

# Extract node_modules if compressed
if [ -f ./node_modules.tar.gz ]; then
  echo "Extracting node_modules.tar.gz..."
  tar -xzf ./node_modules.tar.gz -C /home/site/wwwroot/
else
  echo "Copying node_modules directory..."
  cp -R ./node_modules /home/site/wwwroot/
fi

echo "Deployment complete."
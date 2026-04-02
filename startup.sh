#!/bin/bash
set -e
cd /home/site/wwwroot
npx prisma migrate deploy
npx prisma generate
node dist/server.js

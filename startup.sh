#!/bin/bash
cd /home/site/wwwroot
npx prisma generate
node dist/server.js

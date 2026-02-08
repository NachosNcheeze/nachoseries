# Boundless - Series Database Builder
# Docker container for automated series indexing

FROM node:20-alpine

WORKDIR /app

# Install dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Create data directory
RUN mkdir -p /data

# Environment variables
ENV NODE_ENV=production
ENV BOUNDLESS_DB_PATH=/data/boundless.db

# Volume for persistent data
VOLUME ["/data"]

# Default command
CMD ["node", "dist/index.js", "status"]

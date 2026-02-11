# NachoSeries - Series Database API Server
# Docker container for series lookup service

FROM node:20-slim

WORKDIR /app

# Install dependencies for better-sqlite3 native build
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./

# Install all dependencies (will build native modules for this platform)
RUN npm ci

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Copy non-TS assets that tsc doesn't handle
RUN cp src/database/schema.sql dist/database/schema.sql

# Remove dev dependencies after build
RUN npm prune --production

# Create data directory
RUN mkdir -p /app/data

# Environment variables
ENV NODE_ENV=production
ENV NACHOSERIES_DB_PATH=/app/data/nachoseries.db
ENV NACHOSERIES_PORT=5057

# Expose API port
EXPOSE 5057

# Volume for persistent data (database)
VOLUME ["/app/data"]

# Run the API server
CMD ["node", "dist/api.js"]

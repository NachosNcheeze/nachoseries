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
# Auto-enrich: set to 'true' to run autonomous book/series enrichment on startup
# AUTO_ENRICH_MODE: 'books-only' or 'series-only' (default: both)
# AUTO_ENRICH_GENRE: limit to a specific genre (e.g., 'fantasy')
ENV AUTO_ENRICH=false

# Expose API port
EXPOSE 5057

# Health check — Docker will mark container unhealthy if this fails
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:5057/api/health').then(r=>{if(!r.ok)process.exit(1);return r.json()}).then(d=>{if(d.status!=='ok')process.exit(1)}).catch(()=>process.exit(1))"

# Volume for persistent data (database)
VOLUME ["/app/data"]

# Run the API server
CMD ["node", "dist/api.js"]

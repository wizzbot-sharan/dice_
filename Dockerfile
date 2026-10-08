# Stage 1: Build the React Dashboard
FROM node:20-alpine AS frontend-builder
WORKDIR /app/dashboard
COPY dashboard/package*.json ./
RUN npm install
COPY dashboard/ ./
RUN npm run build

# Stage 2: Final Production Playwright Image
FROM mcr.microsoft.com/playwright:v1.44.0-jammy
WORKDIR /app

# Copy root package.json and install dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the application
COPY . .

# Copy the compiled dashboard into the root public folder
COPY --from=frontend-builder /app/dashboard/dist ./public

# Start the Express server + Cron Worker
CMD ["node", "worker.js"]

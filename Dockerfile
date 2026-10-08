# Use the official Microsoft Playwright image (includes Node.js and all browser dependencies)
FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

# Copy package.json and install dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the app
COPY . .

# Start the worker script
CMD ["node", "worker.js"]

FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install || true

COPY . .

# Worker doesn't usually expose a port
CMD ["npm", "start"]

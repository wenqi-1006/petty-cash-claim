# LVC Petty Cash Claims: Node.js server for Railway.
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js schema.sql petty-cash-claim.html ./
USER node
CMD ["node", "server.js"]

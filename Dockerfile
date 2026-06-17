FROM node:20-alpine

RUN apk add --no-cache \
    docker-cli \
    docker-cli-compose \
    shadow \
    su-exec

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

RUN chown -R appuser:appgroup /app

EXPOSE 3000

ENTRYPOINT ["/docker-entrypoint.sh"]

CMD ["npm", "start"]

FROM node:24-alpine
# Node's http module then sends each request to the a12s proxy as plain HTTP, which a12s needs to stamp the caller.
ENV NODE_USE_ENV_PROXY=1
COPY service.json /a12s/service.json
COPY server.ts /srv/server.ts
USER 1000
CMD ["node", "/srv/server.ts"]

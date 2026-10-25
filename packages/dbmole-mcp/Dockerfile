# Build from the repository root:
#   docker build -f packages/dbmole-mcp/Dockerfile -t dbmole-mcp .
FROM node:22-alpine AS build
WORKDIR /repo
COPY . .
RUN npm ci && npm run build --workspace dbmole-mcp
# Stage only what the runtime install needs: the lockfile, every workspace manifest
# (npm ci checks them against the lockfile) and the bundle (core is inlined).
RUN mkdir -p /out \
    && cp package.json package-lock.json /out/ \
    && for p in packages/*; do mkdir -p /out/$p && cp $p/package.json /out/$p/; done \
    && cp -r packages/dbmole-mcp/dist /out/packages/dbmole-mcp/dist

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
RUN npm ci --omit=dev --workspace dbmole-mcp --no-audit --no-fund \
    && npm cache clean --force && rm -rf /tmp/*
RUN mkdir -p /work /home/node/.config/dbmole && chown node:node /work /home/node/.config/dbmole
USER node
# cwd is where the server looks for .dbmole.json: mount a project at /work to use its file.
WORKDIR /work
ENTRYPOINT ["node", "/app/packages/dbmole-mcp/dist/index.js"]

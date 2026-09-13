ARG NODE_IMAGE=node:22.22.2-bookworm-slim
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG PNPM_VERSION=11.15.1
FROM ${NODE_IMAGE} AS build
ARG NPM_REGISTRY
ARG PNPM_VERSION
WORKDIR /app
RUN npm install --global "pnpm@${PNPM_VERSION}" --registry="${NPM_REGISTRY}" \
    && pnpm config set registry "${NPM_REGISTRY}"
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/api ./apps/api
COPY --from=build /app/apps/web/dist ./apps/web/dist
EXPOSE 3000
CMD ["sh", "-c", "node apps/api/dist/migrate.js && node apps/api/dist/seed.js && node apps/api/dist/server.js"]

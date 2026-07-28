# Mycel harness service — the Task API + orchestrator. Deploy this to the cloud (Fly/Render).
# For cloud, use MYCEL_SANDBOX=daytona (isolated microVMs). For local, MYCEL_SANDBOX=local|docker.
FROM node:22-bookworm-slim
WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY harness ./harness

ENV PORT=4000
EXPOSE 4000
CMD ["npx", "tsx", "harness/src/index.ts"]

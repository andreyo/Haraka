FROM node:24-slim

# Version of haraka to install. https://github.com/haraka/Haraka/releases.
ARG HARAKA_VERSION=3.1.1

# Install packages and build tools required for npm install of some plugins.
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends curl unzip bash vim \
    ca-certificates tzdata make \
    git rsync gettext-base \
    python3 gcc make build-essential libc6-dev \
    && apt-get clean && rm -fr /var/lib/apt/lists/*

# Installs haraka.
RUN npm install -g Haraka@${HARAKA_VERSION}
WORKDIR /haraka

# Copy the haraka config and plugins.
COPY ./config /haraka/config
COPY ./plugins/queue/firestore.js /haraka/plugins/queue/firestore.js
COPY ./plugins/queue/gcp_storage.js /haraka/plugins/queue/gcp_storage.js

# Install pugin dependencies.
RUN npm install @google-cloud/firestore@^7.11.1 && \
    npm install @google-cloud/storage@^7.16.0 && \
    npm install mailparser@^3.7.3

# Sets up default config directories.
RUN haraka -i /haraka

# Symlink the queue folder to /queue so it can be mounted externally
# RUN ln -s /queue /haraka/queue

EXPOSE 25
ENV PORT=25

# Run the app in non-daemon mode.
CMD [ "haraka", "-c", "/haraka" ]

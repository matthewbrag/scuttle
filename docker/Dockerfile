# Scuttle session runtime — the default, lean sandbox base image.
# This is the FLOOR of tooling. Agents install anything else they need at runtime;
# because Scuttle keeps containers (stop/start, never rm until delete), those
# installs persist. So this file rarely needs to change.
#
# No GPU/CUDA here on purpose — most coding-agent work doesn't need it, and a
# multi-GB download is a bad first impression. If your work is ML-heavy, see
# docker/Dockerfile.gpu-ml.example for a build-your-own-tag pattern that layers
# PyTorch/CUDA on top without touching this default.
#
# Runs as a non-root user whose uid/gid match the host, so files the agent writes
# to a bind-mounted project come out owned by you, not root. Passwordless sudo for
# apt, so `apt install X` just works when an agent needs something not in here.
#
# Build:  docker build -t scuttle-runtime --build-arg UID=$(id -u) --build-arg GID=$(id -g) docker/
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_ROOT_USER_ACTION=ignore \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# --- expensive, cache-stable layer (keep identical to preserve build cache) ---
RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl wget ripgrep build-essential ca-certificates jq less nano tmux \
      python3 python3-venv python3-pip nodejs npm \
    && rm -rf /var/lib/apt/lists/*

# --- non-root user + install ergonomics (cheap layers, added after the cached one) ---
ARG UID=1000
ARG GID=1000

RUN apt-get update && apt-get install -y --no-install-recommends sudo \
    && rm -rf /var/lib/apt/lists/*

# ubuntu:24.04 ships a built-in "ubuntu" user at UID 1000, which collides with the
# default UID here (matching most single-user Linux hosts) — drop it first.
RUN userdel -r ubuntu 2>/dev/null || true; \
    groupadd -g ${GID} scuttle 2>/dev/null || true; \
    useradd -m -u ${UID} -g ${GID} -s /bin/bash scuttle && \
    echo 'scuttle ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/scuttle && \
    chmod 0440 /etc/sudoers.d/scuttle

RUN python3 -m venv /home/scuttle/venv && \
    chown -R ${UID}:${GID} /home/scuttle

ENV HOME=/home/scuttle \
    VIRTUAL_ENV=/home/scuttle/venv \
    PATH=/home/scuttle/venv/bin:/home/scuttle/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

USER scuttle
WORKDIR /workspace

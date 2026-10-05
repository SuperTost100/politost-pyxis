FROM node:26-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 build-essential git gh sudo xvfb xauth \
    libgtk-3-0 libnss3 libasound2 libgbm1 libxss1 libfuse2 \
    && rm -rf /var/lib/apt/lists/*

ENV PYXIS_E2E_HIDDEN=1
ENV PYXIS_TEST_E5=.tmp/e5

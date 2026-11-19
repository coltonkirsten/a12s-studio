# The image of every Studio agent computer: a12s's slim plus the tools agents reach for most.
# setup.sh builds it as AGENT_IMAGE in packages/contract/src/names.ts; a change here takes a new tag there.
ARG A12S_RELEASE
FROM ghcr.io/coltonkirsten/a12s/slim:${A12S_RELEASE}

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3-pip python3-venv pandoc libpango-1.0-0 libpangoft2-1.0-0 chromium \
      fonts-dejavu-core fonts-liberation fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/* /usr/lib/python3*/EXTERNALLY-MANAGED \
 && pip install --no-cache-dir weasyprint==66.0

# WeasyPrint comes from pip: Debian's package pulls in SciPy and a compiler through its fonttools.

# The root filesystem is read-only, so pip and npm install into the home drive, where installs survive a restart.
# pip installs into ~/.local by itself once the site-packages it cannot write is no longer marked as managed.
RUN mkdir -p /usr/local/etc && echo 'prefix=/home/agent/.local' > /usr/local/etc/npmrc
ENV PATH=/home/agent/.local/bin:$PATH

# Chromium ignores HTTPS_PROXY, and the proxy is an agent computer's only way out.
COPY chromium-flags /etc/chromium.d/studio

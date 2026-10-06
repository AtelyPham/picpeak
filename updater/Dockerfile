# PicPeak updater, container packaging. Same script as the host agent; see
# docs/self-update.md. Built by .github/workflows/updater-image.yml.
FROM docker:27-cli

ARG VERSION=dev
LABEL org.opencontainers.image.source="https://github.com/PicPeak/picpeak"
LABEL org.opencontainers.image.description="PicPeak updater (opt-in, holds the Docker socket)"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.version="${VERSION}"

# bash for the script; coreutils/findutils stay busybox. flock and comm are in busybox.
RUN apk add --no-cache bash

COPY picpeak-updater.sh /usr/local/bin/picpeak-updater
RUN chmod 0755 /usr/local/bin/picpeak-updater

ENV PICPEAK_UPDATER_PACKAGING=container \
    PICPEAK_UPDATE_DIR=/update

ENTRYPOINT ["/usr/local/bin/picpeak-updater"]
CMD ["watch"]

# VM de tenant simulada: Ubuntu 24.04 + systemd + nginx + ansible-core de apt (igual que la AMI).
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      systemd systemd-sysv nginx ansible-core python3 curl jq nodejs rsync ca-certificates \
    && apt-get clean && rm -rf /var/lib/apt/lists/* \
    && ln -s /usr/bin/node /usr/local/bin/node
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]

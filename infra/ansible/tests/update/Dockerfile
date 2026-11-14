# VM de tenant simulada: Ubuntu 24.04 + systemd + nginx + ansible-core de apt (igual que la AMI),
# Node 24.15.0 (group_vars/all.yml) y PostgreSQL 16 para correr el backend real en e2e.sh.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      systemd systemd-sysv nginx ansible-core python3 curl jq rsync ca-certificates xz-utils postgresql \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://nodejs.org/dist/v24.15.0/node-v24.15.0-linux-x64.tar.xz \
    | tar -xJ -C /usr/local --strip-components=1 --exclude=CHANGELOG.md --exclude=README.md --exclude=LICENSE
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]

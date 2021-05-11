FROM node:14-alpine

RUN apk update \
  && apk add \
  openssh-client \
  ca-certificates \
  bash

ADD lib/ /znckco/deployer

ENTRYPOINT [ "node", "/znckco/deployer/action.js" ]

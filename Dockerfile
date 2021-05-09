FROM node:12-alpine3.10

RUN apk update \
  && apk add \
  openssh-client \
  ca-certificates \
  bash

ADD lib/ /deployer
WORKDIR /deployer

ENTRYPOINT [ "node", "action.js" ]

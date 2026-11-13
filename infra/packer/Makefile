# Uso (GNU make, desde infra/packer):
#   make packer-init       descarga los plugins
#   make packer-fmt        formatea los .pkr.hcl
#   make packer-validate   valida sin crear nada en AWS
#   make packer-build      construye las 4 AMIs (tarda ~15-20 min y cobra EC2 temporales)
#   make packer-build ONLY=backend    construye solo un rol
#   make packer-ids        muestra las últimas AMIs por rol (ami-ids.json)
# En Windows sin GNU make: ver README.md, los comandos equivalentes están ahí.

VERSION ?= 0.1.0
ONLY    ?=
COMMIT  := $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
VARS    := -var image_version=$(VERSION) -var git_commit=$(COMMIT)
ONLYARG := $(if $(ONLY),-only=attendance.amazon-ebs.$(ONLY),)

.PHONY: packer-init packer-fmt packer-validate packer-build packer-ids

packer-init:
	packer init .

packer-fmt:
	packer fmt .

packer-validate: packer-init
	packer fmt -check .
	packer validate $(VARS) .

packer-build: packer-validate
	packer build $(VARS) $(ONLYARG) .
	python3 scripts/ami_ids.py ami-manifest.json ami-ids.json

packer-ids:
	python3 scripts/ami_ids.py ami-manifest.json ami-ids.json

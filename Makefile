.PHONY: apply-raycast

apply-raycast:
	npm ci --prefix raycast
	npm run build --prefix raycast

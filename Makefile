BIN := bin/devtil

.PHONY: build run test vet cross desktop release clean

build: ## build the devtil binary (UI embedded)
	go build -o $(BIN) .

run: build ## build and run locally
	./$(BIN)

vet:
	go vet ./...

test:
	go test ./...

cross: ## cross-compile for mac (arm64/amd64), windows and linux into dist/
	GOOS=darwin  GOARCH=arm64 go build -o dist/devtil-darwin-arm64 .
	GOOS=darwin  GOARCH=amd64 go build -o dist/devtil-darwin-amd64 .
	GOOS=windows GOARCH=amd64 go build -o dist/devtil-windows-amd64.exe .
	GOOS=linux   GOARCH=amd64 go build -o dist/devtil-linux-amd64 .

desktop: build ## run the native Electron shell (requires: cd desktop && npm install)
	cd desktop && npm start

release: ## build binaries and upload them to a GitHub Release (make release TAG=v1.0.0)
	@test -n "$(TAG)" || { echo "usage: make release TAG=v1.0.0"; exit 1; }
	@scripts/release.sh $(TAG)

clean:
	rm -rf bin dist

docker stop yuerouter
docker rm yuerouter
docker build -t yuerouter .
docker run -d --name yuerouter -p 20128:20128 --env-file .env -v yuerouter-data:/app/data yuerouter
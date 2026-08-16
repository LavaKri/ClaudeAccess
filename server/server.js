import express from 'express';

const config = {
	host: 'localhost',
	port: 1080,
	webdir: 'front',
};

const app = express();
app.use(express.static(config.webdir));

app.listen(config.port, config.host, () => {
	console.log(`Server listening on http://${config.host}:${config.port}`);
});

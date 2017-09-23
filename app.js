const express = require('express');
const app = express();
const path = require('path');
const JSON = require('json5');
const fs = require('fs-extra-promise');
const crypto = require('crypto');
const PromiseQueue = require('promise-queue');
const execa = require('execa');
const chalk = require('chalk');

const configPath = path.resolve(__dirname, './config/config.json5');
let config, listener;
async function reloadConfig() {
    try {
        let data = await fs.readFileAsync(configPath, 'utf8');
        config = JSON.parse(data);
        console.log('Config (re-)loaded!');
        if (!listener) {
            listener = app.listen(config.listenPort);
            console.log(`listening on ${config.listenPort}`);
        }
    } catch (err) {
        console.log('Error reloading config:', err.message);
    }
}
reloadConfig();
fs.watchFile(configPath, () => {
    reloadConfig();
});

function streamConcat(stream) {
    return new Promise((resolve, reject) => {
        const payload = [];
        stream.on('data', buff => payload.push(buff));
        stream.once('end', () => {
            try {
                resolve(Buffer.concat(payload));
            } catch (err) {
                reject(err);
            }
        });
        stream.once('error', reject);
    });
}

const deployQueue = new PromiseQueue(1, Infinity);
async function queueDeploy(hook) {
    return deployQueue.add(async () => {
        console.log(chalk.yellow.bold(`Running deploy hook:`), hook);
        const shellExt = /^win/.test(process.platform) ? '.cmd' : '.sh';
        const deployScript = path.resolve(__dirname, './config', `${hook}${shellExt}`);
        console.log(deployScript);
        return await new Promise((resolve, reject) => {
            let cp = execa(deployScript, [], {detached: true});
            cp.stdout.on('data', d=>console.log(chalk.yellow(`${hook} >>>`), String(d).trim()));
            cp.once('close', resolve);
            return cp;
        });
    });
}

app.post('*', async (req, res) => {
    try {
        if (req.headers['x-github-event'] !== 'push'
            || !req.headers['content-length']
            || !req.headers['x-github-delivery']
            || !req.headers['x-hub-signature']
            || !(/^GitHub-Hookshot\b/.test(String(req.headers['user-agent'])))
        ) {
            throw Error("Bad request");
        }

        let ct = req.headers['content-type'];
        if (ct !== 'application/json') {
            throw Error("Only application/json is accepted");
        }

        const event = req.headers['x-github-event'];
        const body = await streamConcat(req);
        const js = JSON.parse(body);
        const branch = js.ref.split('/').pop();
        const repo = js.repository.full_name;

        console.log("GitHook push:", repo, branch);

        const hook = config.hooks.find(h => h.repo === repo && (h.branch||"master") === branch);
        if (!hook) {
            throw Error(`No hook defined for ${repo}/${branch}`);
        }

        const hash = crypto.createHmac('sha1', hook.secret).update(body).digest('hex');
        if (req.headers['x-hub-signature'] !== `sha1=${hash}`) {
            throw Error('Bad signature');
        }

        await queueDeploy(repo);

        res.status(204).send();
    } catch (err) {
        console.log(err.stack);
        res.status(400).send(err.message);
    }
});

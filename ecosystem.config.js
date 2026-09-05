// PM2 config — đổi name theo domain khi cài nhiều nơi (vd: zalo-inbox-khach1)
module.exports = {
    apps: [
        {
            name: 'zalo-inbox',
            script: 'src/server.js',
            cwd: __dirname,
            instances: 1,
            autorestart: true,
            max_memory_restart: '500M',
            env: {
                NODE_ENV: 'production',
            },
        },
    ],
};

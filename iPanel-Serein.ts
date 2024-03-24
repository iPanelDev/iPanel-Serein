/// <reference path="SereinJSPluginHelper/index.d.ts"/>

declare interface Packet {
    type: string;
    subType: string;
    data?: any;
}

declare interface IConfig {
    customName?: string;
    websocket: {
        addr: string;
        password: string;
    };
    reconnect: {
        enable: boolean;
        interval: number;
        maxTimes: number;
    };
}

declare interface IInfo {
    verified: boolean;
    disconnectInfo?: string;
    trialTimes: number;
}

const VERSION = '2.3.0.0';
serein.registerPlugin(
    'iPanel-Serein',
    VERSION,
    'Zaitonn',
    '网页版控制台-Serein插件'
);
serein.setListener('onPluginsLoaded', connect);
serein.setListener('onServerStart', onServerStart);
serein.setListener('onServerStop', onServerStop);
serein.setListener('onServerSendCommand', onServerSendCommand);
serein.setListener('onServerOriginalOutput', onServerOriginalOutput);

const {
    Security: {
        Cryptography: { MD5 },
    },
    Text: { Encoding },
    Environment,
    Guid,
    IO: { File },
} = System;

const logger = new Logger('iPanel');
const paths = {
    dir: 'plugins/iPanel-Serein',
    config: 'plugins/iPanel-Serein/config.json',
    instanceID: 'plugins/iPanel-Serein/.instanceId',
};

const inputCache = [];
const outputCache = [];

/**
 * 默认配置
 */
const defaultConfig: IConfig = {
    websocket: {
        addr: 'ws://127.0.0.1:30000/ws/instance',
        password: '',
    },
    customName: '',
    reconnect: {
        enable: true,
        interval: 1000 * 7.5,
        maxTimes: 10,
    },
};

import stdio = require('./modules/stdio.js');

const { createDirectory, existFile, readAllTextFromFile, writeAllTextToFile } =
    stdio;

const config = loadConfig();

let ws: WSClient = null;

const info: IInfo = {
    verified: false,
    trialTimes: 0,
};

/**
 * 发送数据包
 * @param packet 数据包
 */
function send(packet: Packet) {
    if (ws?.state === 1) {
        ws.send(JSON.stringify(packet));
    }
}

/**
 * 快速发送
 */
function fastSend(type: string, subType: string, data?: any) {
    send({ type, subType: subType, data });
}

/**
 * 消息事件
 */
function onmessage(msg: string) {
    const packet = JSON.parse(msg) as Packet;

    switch (packet.type) {
        case 'request':
            handleRequest(packet);
            break;

        case 'event':
            handleEvent(packet);
            break;
    }
}

/**
 * 处理event
 */
function handleEvent({ subType, data }: Packet) {
    switch (subType) {
        case 'verify_result':
            if (data.success) {
                logger.info('[Host] 验证通过');
                info.verified = true;
            } else logger.info(`[Host] 验证失败: ${data.reason}`);
            break;

        case 'disconnection':
            info.disconnectInfo = data.reason;
            break;
    }
}

/**
 * 处理request
 */
function handleRequest({ subType, data }: Packet) {
    switch (subType) {
        case 'heartbeat':
            const {
                name: os,
                hardware: {
                    CPUs: [{ name: cpuName }],
                    RAM: { free: freeRam, total: totalRam },
                },
            } = serein.getSysInfo();
            const motd = serein.getServerMotd();
            send({
                type: 'return',
                subType: 'heartbeat',
                data: {
                    system: {
                        os,
                        cpuName,
                        totalRam,
                        freeRam,
                        cpuUsage: serein.getCPUUsage(),
                    },
                    server: {
                        filename:
                            (serein.getServerStatus() &&
                                serein.getServerFile()) ||
                            null,
                        status: serein.getServerStatus(),
                        runTime: serein.getServerTime() || null,
                        usage: serein.getServerCPUUsage(),
                        capacity: motd?.maxPlayer,
                        onlinePlayers: motd?.onlinePlayer,
                        version: motd?.version,
                    },
                },
            });
            break;

        case 'server_start':
            logger.info(`[用户] 启动服务器`);
            serein.startServer();
            break;

        case 'server_stop':
            logger.info(`[用户] 关闭服务器`);
            serein.stopServer();
            break;

        case 'server_kill':
            logger.warn(`[用户] 强制结束服务器`);
            serein.killServer();
            break;

        case 'server_input':
            logger.info(`[用户] 服务器输入`);
            Array.from(data).forEach((line: string) => serein.sendCmd(line));
            break;
    }
}

/**
 * 获取MD5
 * @param text 输入文本
 * @returns MD5值
 */
function getMD5(text: string) {
    let result = '';
    MD5.Create()
        .ComputeHash(Encoding.UTF8.GetBytes(String(text)))
        .forEach(
            (byte: Number) =>
                (result += Number(byte).toString(16).padStart(2, '0'))
        );
    return result;
}

/**
 * 连接
 */
function connect() {
    ws = new WSClient(config.websocket.addr, serein.namespace);
    ws.onopen = onopen;
    ws.onclose = onclose;
    ws.onmessage = onmessage;
    ws.open();
}

/**
 * 开启事件
 */
function onopen() {
    info.disconnectInfo = undefined;
    info.trialTimes = 0;
    logger.info(`已连接到“${config.websocket.addr}”`);

    const time = new Date().toISOString();
    send({
        type: 'request',
        subType: 'verify',
        data: {
            md5: getMD5(`${time}.${config.websocket.password}`),
            instanceId: loadInstanceID(),
            customName: config.customName || null,
            time,
            metadata: {
                version: serein.version,
                name: 'Serein',
                environment: `NET ${Environment.Version.ToString()}`,
            },
        },
    });
}

/**
 * 关闭事件
 */
function onclose() {
    logger.warn(
        `连接已断开${info.disconnectInfo ? ': ' + info.disconnectInfo : ''}`
    );
    if (!info.verified)
        logger.warn(
            '貌似没有成功连接过，自动重连已关闭。请检查地址是否配置正确'
        );
    else {
        // @ts-ignore
        setTimeout(reconnect, config.reconnect.interval);
    }
}

/**
 * 重连
 */
function reconnect() {
    info.trialTimes += 1;
    if (info.trialTimes < config.reconnect.maxTimes) {
        logger.info(
            `尝试重连中...${info.trialTimes}/${config.reconnect.maxTimes}`
        );
        connect();
    } else {
        logger.warn('重连次数已达上限');
    }
}

/**
 * 发送输入缓存
 */
function sendInputCache() {
    if (inputCache.length > 0) {
        fastSend('broadcast', 'server_input', inputCache);
        inputCache.splice(0, inputCache.length);
    }
}

/**
 * 发送输出缓存
 */
function sendOutputCache() {
    if (outputCache.length > 0) {
        fastSend('broadcast', 'server_output', outputCache);
        outputCache.splice(0, outputCache.length);
    }
}

/**
 * 服务器开启
 */
function onServerStart() {
    fastSend('broadcast', 'server_start');
}

/**
 * 服务器关闭
 */
function onServerStop(code: number) {
    fastSend('broadcast', 'server_stop', code);
}

/**
 * 服务器输入
 */
function onServerSendCommand(line: string) {
    inputCache.push(line);
}

/**
 * 服务器输出
 */
function onServerOriginalOutput(line: string) {
    outputCache.push(line);
}

/**
 * 加载配置文件
 * @returns 配置
 */
function loadConfig(): IConfig {
    if (existFile(paths.config)) {
        const config = JSON.parse(readAllTextFromFile(paths.config));
        checkConfig(config);
        return config;
    } else {
        createConfigFile();
        if (Environment.Version.Major == 6) {
            serein.setPreLoadConfig([
                'System.Security.Cryptography.Algorithms',
            ]);
        }
        throw new Error('配置文件已创建，请修改后重新加载此插件');
    }
}

/**
 * 加载实例ID
 * @returns 实例ID
 */
function loadInstanceID() {
    if (existFile(paths.instanceID)) {
        const id = (File.ReadAllBytes(paths.instanceID) as number[])
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join('');

        if (/^\w{32}$/.test(id)) return id;
    }
    const newId: string = Guid.NewGuid().ToString('N');
    logger.warn(`新的实例ID已生成：${newId}`);
    createDirectory(paths.dir);

    const bytes = [];
    for (let index = 0; index < newId.length; index += 2) {
        bytes.push(parseInt(`${newId[index]}${newId[index + 1]}`, 16));
    }
    File.WriteAllBytes(paths.instanceID, bytes);
    return newId;
}

/**
 * 创建配置文件
 */
function createConfigFile() {
    createDirectory(paths.dir);
    writeAllTextToFile(paths.config, JSON.stringify(defaultConfig, null, 2));
}

/**
 * 检查配置
 * @param config 配置对象
 */
function checkConfig(config: IConfig) {
    if (!config.customName) logger.warn('配置文件中自定义名称为空');

    if (!config.websocket)
        throw new Error(
            '配置文件中`websocket`项丢失，请删除配置文件后重新加载以创建'
        );

    if (!config.reconnect)
        throw new Error(
            '配置文件中`reconnect`项丢失，请删除配置文件后重新加载以创建'
        );

    if (!config.websocket.addr)
        throw new Error('配置文件中`websocket.addr`项为空');

    if (!config.websocket.password)
        throw new Error('配置文件中`websocket.password`项为空');

    if (typeof config.websocket.addr != 'string')
        throw new Error('配置文件中`websocket.addr`类型不正确');

    if (typeof config.websocket.password != 'string')
        throw new Error('配置文件中`websocket.password`类型不正确');

    if (!/^wss?:\/\/.+/.test(config.websocket.addr))
        throw new Error('配置文件中`websocket.addr`项格式不正确');

    if (typeof config.reconnect.enable != 'boolean')
        throw new Error('配置文件中`reconnect.enable`类型不正确');

    if (typeof config.reconnect.interval != 'number')
        throw new Error('配置文件中`reconnect.interval`类型不正确');

    if (typeof config.reconnect.maxTimes != 'number')
        throw new Error('配置文件中`reconnect.maxTimes`类型不正确');

    if (config.reconnect.interval <= 500)
        throw new Error('配置文件中`reconnect.interval`数值超出范围');

    if (config.reconnect.maxTimes < 0)
        throw new Error('配置文件中`reconnect.maxTimes`数值超出范围');
}

// @ts-ignore
setInterval(() => {
    sendInputCache();
    sendOutputCache();
}, 250);

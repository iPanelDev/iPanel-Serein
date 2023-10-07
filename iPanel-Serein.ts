/// <reference path="SereinJSPluginHelper/index.d.ts"/>

declare interface Packet {
    type: string;
    sub_type: string;
    echo?: any;
    data?: any;
    sender?: any;
    request_id?: string;
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

declare interface DirInfo {
    is_exist: boolean;
    dir: string;
    items?: Item[];
}

declare interface Item {
    type: "file" | "dir";
    path: string;
    name: string;
    size?: number;
}

const VERSION = "2.2.0";
serein.registerPlugin(
    "iPanel-Serein",
    VERSION,
    "Zaitonn",
    "网页版控制台-Serein插件"
);
serein.setListener("onPluginsLoaded", connect);
serein.setListener("onServerStart", onServerStart);
serein.setListener("onServerStop", onServerStop);
serein.setListener("onServerSendCommand", onServerSendCommand);
serein.setListener("onServerOriginalOutput", onServerOriginalOutput);

const {
    Security: {
        Cryptography: { MD5 },
    },
    Text: { Encoding },
    Environment,
    Guid,
    IO: { File, FileInfo, Path },
} = System;

const logger = new Logger("iPanel");
const paths = {
    config: "plugins/iPanel-Serein/config.json",
    dir: "plugins/iPanel-Serein",
    instanceID: "plugins/iPanel-Serein/.instanceId",
};

const inputCache = [];
const outputCache = [];

/**
 * 默认配置
 */
const defaultConfig: IConfig = {
    websocket: {
        addr: "ws://127.0.0.1:30000",
        password: "",
    },
    customName: "",
    reconnect: {
        enable: true,
        interval: 1000 * 7.5,
        maxTimes: 10,
    },
};

import stdio = require("./modules/stdio.js");

const {
    createDirectory,
    existDirectory,
    existFile,
    getDirectories,
    getFileName,
    getFiles,
    readAllTextFromFile,
    writeAllTextToFile,
} = stdio;

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
function fastSend(type: string, sub_type: string, data?: any) {
    send({ type, sub_type, data });
}

/**
 * 消息事件
 */
function onmessage(msg: string) {
    const packet = JSON.parse(msg) as Packet;

    switch (packet.type) {
        case "request":
            handleRequest(packet);
            break;

        case "event":
            handleEvent(packet);
            break;
    }
}

/**
 * 处理event
 */
function handleEvent({ sub_type, data }: Packet) {
    switch (sub_type) {
        case "verify_result":
            if (data.success) {
                logger.info("[Host] 验证通过");
                info.verified = true;
            } else logger.info(`[Host] 验证失败: ${data.reason}`);
            break;

        case "disconnection":
            info.disconnectInfo = data.reason;
            break;
    }
}

/**
 * 处理request
 */
function handleRequest({ sub_type, data, sender, request_id }: Packet) {
    switch (sub_type) {
        case "verify_request":
            send({
                type: "request",
                sub_type: "verify",
                data: {
                    instance_id: loadInstanceID(),
                    token: getMD5(data.uuid + config.websocket.password),
                    custom_name: config.customName || null,
                    client_type: "instance",
                    metadata: {
                        version: serein.version,
                        name: "Serein",
                    },
                },
            });
            break;

        case "heartbeat":
            const {
                name: os,
                hardware: {
                    CPUs: [{ name: cpu_name }],
                    RAM: { free: free_ram, total: total_ram },
                },
            } = serein.getSysInfo();
            send({
                type: "return",
                sub_type: "heartbeat",
                data: {
                    sys: {
                        os,
                        cpu_name,
                        total_ram,
                        free_ram,
                        cpu_usage: serein.getCPUUsage(),
                    },
                    server: {
                        filename:
                            (serein.getServerStatus() &&
                                serein.getServerFile()) ||
                            null,
                        status: serein.getServerStatus(),
                        run_time: serein.getServerTime() || null,
                        usage: serein.getServerCPUUsage(),
                    },
                },
            });
            break;

        case "server_start":
            logger.info(`[${sender.address}] 启动服务器`);
            serein.startServer();
            break;

        case "server_stop":
            logger.info(`[${sender.address}] 关闭服务器`);
            serein.stopServer();
            break;

        case "server_kill":
            logger.warn(`[${sender.address}] 强制结束服务器`);
            serein.killServer();
            break;

        case "server_input":
            logger.info(`[${sender.address}] 服务器输入`);
            Array.from(data).forEach((line: string) => serein.sendCmd(line));
            break;

        case "get_dir_info":
            const abosultePath = getAbosultePath(data);
            if (
                !existDirectory(abosultePath) ||
                !checkPath(abosultePath, serein.path)
            ) {
                send({
                    type: "return",
                    sub_type: "dir_info",
                    data: { is_exist: false, dir: data } as DirInfo,
                    request_id,
                });
                break;
            }
            const items: Item[] = [];
            getDirectories(abosultePath)
                .map((dir) => dir.replaceAll("\\", "/"))
                .forEach((dir) => {
                    items.push({
                        type: "dir",
                        name: dir.substring(dir.lastIndexOf("/") + 1),
                        path: getRelativePath(dir, serein.path).replaceAll(
                            "\\",
                            "/"
                        ),
                    });
                });
            getFiles(abosultePath)
                .map((file) => file.replaceAll("\\", "/"))
                .forEach((file) => {
                    items.push({
                        type: "file",
                        name: getFileName(file),
                        path: getRelativePath(file, serein.path).replaceAll(
                            "\\",
                            "/"
                        ),
                        size: new FileInfo(file).length,
                    });
                });

            send({
                type: "return",
                sub_type: "dir_info",
                data: {
                    is_exist: true,
                    dir: data,
                    items,
                } as DirInfo,
                request_id,
            });
            break;
    }
}

/**
 * 检查路径
 * @param path 要检查的路径
 * @param safePath 安全路径
 * @returns 检查结果
 */
function checkPath(path: string, safePath: string) {
    const patten = path.split(Path.DirectorySeparatorChar),
        safePathPatten = safePath.split(Path.DirectorySeparatorChar);

    for (let i = 0; i < safePathPatten.length; i++) {
        if (safePathPatten[i] && safePathPatten[i] != patten[i]) {
            return false;
        }
    }
    return true;
}

/**
 * 获取绝对路径
 * @param path 路径
 * @returns 拼接后的路径
 */
function getAbosultePath(path: string, basePath?: string) {
    try {
        return (
            Path.Combine(basePath || serein.path, path) as string
        ).replaceAll("/", Path.DirectorySeparatorChar);
    } catch {
        return "";
    }
}

/**
 * 获取相对路径
 * @returns 拼接后的路径
 */
function getRelativePath(relativeTo: string, path: string) {
    const relativeToPattens = relativeTo.replaceAll("\\", "/").split("/");
    const pathPattens = path.replaceAll("\\", "/").split("/");
    const result = [];

    for (let i = 0; i < relativeToPattens.length; i++) {
        if (relativeToPattens[i] != pathPattens[i] && !pathPattens[i]) {
            result.push(relativeToPattens[i]);
        }
    }
    return result.join("/");
}

/**
 * 获取MD5
 * @param text 输入文本
 * @returns MD5值
 */
function getMD5(text: string) {
    let result = "";
    MD5.Create()
        .ComputeHash(Encoding.UTF8.GetBytes(String(text)))
        .forEach(
            (byte: Number) =>
                (result += Number(byte).toString(16).padStart(2, "0"))
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
}

/**
 * 关闭事件
 */
function onclose() {
    logger.warn(
        `连接已断开${info.disconnectInfo ? ": " + info.disconnectInfo : ""}`
    );
    if (!info.verified)
        logger.warn(
            "貌似没有成功连接过，自动重连已关闭。请检查地址是否配置正确"
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
        logger.warn("重连次数已达上限");
    }
}

/**
 * 发送输入缓存
 */
function sendInputCache() {
    if (inputCache.length > 0) {
        fastSend("broadcast", "server_input", inputCache);
        inputCache.splice(0, inputCache.length);
    }
}

/**
 * 发送输出缓存
 */
function sendOutputCache() {
    if (outputCache.length > 0) {
        fastSend("broadcast", "server_output", outputCache);
        outputCache.splice(0, outputCache.length);
    }
}

/**
 * 服务器开启
 */
function onServerStart() {
    fastSend("broadcast", "server_start");
}

/**
 * 服务器关闭
 */
function onServerStop(code: number) {
    fastSend("broadcast", "server_stop", code);
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
                "System.Security.Cryptography.Algorithms",
            ]);
        }
        throw new Error("配置文件已创建，请修改后重新加载此插件");
    }
}

/**
 * 加载实例ID
 * @returns 实例ID
 */
function loadInstanceID() {
    if (existFile(paths.instanceID)) {
        const id = (File.ReadAllBytes(paths.instanceID) as number[])
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");

        if (/^\w{32}$/.test(id)) return id;
    }
    const newId: string = Guid.NewGuid().ToString("N");
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
    writeAllTextToFile(paths.config, JSON.stringify(defaultConfig, null, 4));
}

/**
 * 检查配置
 * @param config 配置对象
 */
function checkConfig(config: IConfig) {
    if (!config.customName) logger.warn("配置文件中自定义名称为空");

    if (!config.websocket)
        throw new Error(
            "配置文件中`websocket`项丢失，请删除配置文件后重新加载以创建"
        );

    if (!config.reconnect)
        throw new Error(
            "配置文件中`reconnect`项丢失，请删除配置文件后重新加载以创建"
        );

    if (!config.websocket.addr)
        throw new Error("配置文件中`websocket.addr`项为空");

    if (!config.websocket.password)
        throw new Error("配置文件中`websocket.password`项为空");

    if (typeof config.websocket.addr != "string")
        throw new Error("配置文件中`websocket.addr`类型不正确");

    if (typeof config.websocket.password != "string")
        throw new Error("配置文件中`websocket.password`类型不正确");

    if (!/^wss?:\/\/.+/.test(config.websocket.addr))
        throw new Error("配置文件中`websocket.addr`项格式不正确");

    if (typeof config.reconnect.enable != "boolean")
        throw new Error("配置文件中`reconnect.enable`类型不正确");

    if (typeof config.reconnect.interval != "number")
        throw new Error("配置文件中`reconnect.interval`类型不正确");

    if (typeof config.reconnect.maxTimes != "number")
        throw new Error("配置文件中`reconnect.maxTimes`类型不正确");

    if (config.reconnect.interval <= 500)
        throw new Error("配置文件中`reconnect.interval`数值超出范围");

    if (config.reconnect.maxTimes < 0)
        throw new Error("配置文件中`reconnect.maxTimes`数值超出范围");
}

// @ts-ignore
setInterval(() => {
    sendInputCache();
    sendOutputCache();
}, 250);

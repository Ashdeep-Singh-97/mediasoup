"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const http_1 = require("http");
const socket_io_1 = require("socket.io");
const mediasoup = __importStar(require("mediasoup"));
const app = (0, express_1.default)();
const httpServer = (0, http_1.createServer)(app);
const io = new socket_io_1.Server(httpServer, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
        credentials: true,
    },
});
let worker;
let router;
let producerTransport;
let consumerTransport;
let producers = {};
let consumer;
function startMediasoup() {
    return __awaiter(this, void 0, void 0, function* () {
        console.log('LOG: Starting Mediasoup worker');
        worker = yield mediasoup.createWorker({
            rtcMinPort: 2000,
            rtcMaxPort: 2020,
        });
        console.log('LOG: Worker created, PID:', worker.pid);
        worker.on('died', () => {
            console.error('LOG: Mediasoup worker died, exiting in 2 seconds...');
            setTimeout(() => process.exit(1), 2000);
        });
        router = yield worker.createRouter({
            mediaCodecs: [
                {
                    kind: 'video',
                    mimeType: 'video/VP8',
                    clockRate: 90000,
                },
                {
                    kind: 'audio',
                    mimeType: 'audio/opus',
                    clockRate: 48000,
                    channels: 2,
                },
            ],
        });
        console.log('LOG: Router created, codecs:', router.rtpCapabilities.codecs);
    });
}
function createWebRtcTransport() {
    return __awaiter(this, void 0, void 0, function* () {
        console.log('LOG: Creating WebRTC transport');
        const transport = yield router.createWebRtcTransport({
            listenIps: [{ ip: '0.0.0.0', announcedIp: '127.0.0.1' }],
            enableUdp: true,
            enableTcp: true,
            preferUdp: true,
        });
        console.log('LOG: Transport created, ID:', transport.id);
        console.log('LOG: Transport ICE parameters:', transport.iceParameters);
        console.log('LOG: Transport ICE candidates:', transport.iceCandidates);
        return transport;
    });
}
app.get('/', (_req, res) => {
    console.log('LOG: GET / request received');
    res.send('Mediasoup server running!');
});
io.on('connection', (socket) => __awaiter(void 0, void 0, void 0, function* () {
    console.log('LOG: Client connected, socket ID:', socket.id);
    console.log('LOG: Client origin:', socket.handshake.headers.origin);
    socket.on('getRouterRtpCapabilities', (callback) => {
        console.log('LOG: Client requested router RTP capabilities');
        console.log('LOG: Sending RTP capabilities:', router.rtpCapabilities);
        callback(router.rtpCapabilities);
    });
    socket.on('createProducerTransport', (callback) => __awaiter(void 0, void 0, void 0, function* () {
        console.log('LOG: Creating producer transport');
        producerTransport = yield createWebRtcTransport();
        console.log('LOG: Producer transport created, ID:', producerTransport.id);
        callback({
            id: producerTransport.id,
            iceParameters: producerTransport.iceParameters,
            iceCandidates: producerTransport.iceCandidates,
            dtlsParameters: producerTransport.dtlsParameters,
        });
        console.log('LOG: Producer transport data sent to client');
    }));
    socket.on('connectProducerTransport', (_a, callback_1) => __awaiter(void 0, [_a, callback_1], void 0, function* ({ dtlsParameters }, callback) {
        console.log('LOG: Connecting producer transport, DTLS:', dtlsParameters);
        if (producerTransport) {
            try {
                yield producerTransport.connect({ dtlsParameters });
                console.log('LOG: Producer transport connected, ID:', producerTransport.id);
                callback();
            }
            catch (error) {
                console.error('LOG: Error connecting producer transport:', error);
                callback({ error: 'Failed to connect producer transport' });
            }
        }
        else {
            console.error('LOG: Producer transport not found');
            callback({ error: 'Producer transport not found' });
        }
    }));
    socket.on('produce', (_a, callback_1) => __awaiter(void 0, [_a, callback_1], void 0, function* ({ kind, rtpParameters }, callback) {
        console.log('LOG: Producing media, kind:', kind, 'RTP:', rtpParameters);
        if (producerTransport) {
            try {
                const producer = yield producerTransport.produce({ kind, rtpParameters });
                producers[producer.kind] = producer;
                console.log('LOG: Producer created, ID:', producer.id, 'Kind:', producer.kind);
                console.log('LOG: Producer state:', producer.closed);
                callback({ id: producer.id, kind: producer.kind });
            }
            catch (error) {
                console.error('LOG: Error creating producer:', error);
                callback({ error: 'Failed to create producer' });
            }
        }
        else {
            console.error('LOG: Producer transport not found');
            callback({ error: 'Producer transport not found' });
        }
    }));
    socket.on('createConsumerTransport', (callback) => __awaiter(void 0, void 0, void 0, function* () {
        console.log('LOG: Creating consumer transport');
        consumerTransport = yield createWebRtcTransport();
        console.log('LOG: Consumer transport created, ID:', consumerTransport.id);
        callback({
            id: consumerTransport.id,
            iceParameters: consumerTransport.iceParameters,
            iceCandidates: consumerTransport.iceCandidates,
            dtlsParameters: consumerTransport.dtlsParameters,
        });
        console.log('LOG: Consumer transport data sent to client');
    }));
    socket.on('connectConsumerTransport', (_a, callback_1) => __awaiter(void 0, [_a, callback_1], void 0, function* ({ dtlsParameters }, callback) {
        console.log('LOG: Connecting consumer transport, DTLS:', dtlsParameters);
        if (consumerTransport) {
            try {
                yield consumerTransport.connect({ dtlsParameters });
                console.log('LOG: Consumer transport connected, ID:', consumerTransport.id);
                callback();
            }
            catch (error) {
                console.error('LOG: Error connecting consumer transport:', error);
                callback({ error: 'Failed to connect consumer transport' });
            }
        }
        else {
            console.error('LOG: Consumer transport not found');
            callback({ error: 'Consumer transport not found' });
        }
    }));
    socket.on('consume', (_a, callback_1) => __awaiter(void 0, [_a, callback_1], void 0, function* ({ rtpCapabilities }, callback) {
        console.log('LOG: Consuming media, RTP capabilities:', rtpCapabilities);
        console.log('LOG: Available producers:', Object.keys(producers));
        const videoProducer = producers['video'];
        if (!videoProducer) {
            console.error('LOG: Cannot consume: No video producer exists');
            callback({ error: 'No video producer exists' });
            return;
        }
        console.log('LOG: Video producer found, ID:', videoProducer.id);
        if (!router.canConsume({ producerId: videoProducer.id, rtpCapabilities })) {
            console.error('LOG: Cannot consume: Incompatible RTP capabilities');
            console.log('LOG: Router RTP capabilities:', router.rtpCapabilities);
            console.log('LOG: Client RTP capabilities:', rtpCapabilities);
            callback({ error: 'Incompatible RTP capabilities' });
            return;
        }
        if (!consumerTransport) {
            console.error('LOG: Cannot consume: No consumer transport exists');
            callback({ error: 'No consumer transport exists' });
            return;
        }
        try {
            consumer = yield consumerTransport.consume({
                producerId: videoProducer.id,
                rtpCapabilities,
                paused: false,
            });
            console.log('LOG: Consumer created, ID:', consumer.id, 'Kind:', consumer.kind);
            console.log('LOG: Consumer state:', consumer.closed);
            callback({
                producerId: videoProducer.id,
                id: consumer.id,
                kind: consumer.kind,
                rtpParameters: consumer.rtpParameters,
            });
        }
        catch (error) {
            console.error('LOG: Error creating consumer:', error);
            callback({ error: 'Failed to create consumer' });
        }
    }));
    socket.on('disconnect', () => {
        console.log('LOG: Client disconnected, socket ID:', socket.id);
        console.log('LOG: Closing producers and consumer');
        Object.values(producers).forEach((producer) => producer.close());
        consumer === null || consumer === void 0 ? void 0 : consumer.close();
        producerTransport === null || producerTransport === void 0 ? void 0 : producerTransport.close();
        consumerTransport === null || consumerTransport === void 0 ? void 0 : consumerTransport.close();
        producers = {};
        consumer = undefined;
        producerTransport = undefined;
        consumerTransport = undefined;
        console.log('LOG: Cleanup complete');
    });
}));
function startServer() {
    return __awaiter(this, void 0, void 0, function* () {
        console.log('LOG: Starting server');
        yield startMediasoup();
        httpServer.listen(5000, () => {
            console.log('LOG: Server running on http://localhost:5000');
        });
    });
}
startServer();

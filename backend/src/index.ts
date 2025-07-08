import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import * as mediasoup from 'mediasoup';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

let worker: mediasoup.types.Worker;
let router: mediasoup.types.Router;
const transports: { [socketId: string]: { producerTransport?: mediasoup.types.WebRtcTransport; consumerTransport?: mediasoup.types.WebRtcTransport } } = {};
const producers: { [socketId: string]: mediasoup.types.Producer[] } = {};
const roles: { [socketId: string]: string } = {}; // Track client roles
let consumer: mediasoup.types.Consumer | undefined;

async function startMediasoup() {
  console.log('LOG: Starting Mediasoup worker');
  worker = await mediasoup.createWorker({
    rtcMinPort: 2000,
    rtcMaxPort: 2020,
  });
  console.log('LOG: Worker created, PID:', worker.pid);

  worker.on('died', () => {
    console.error('LOG: Mediasoup worker died, exiting in 2 seconds...');
    setTimeout(() => process.exit(1), 2000);
  });

  router = await worker.createRouter({
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
}

async function createWebRtcTransport() {
  console.log('LOG: Creating WebRTC transport');
  const transport = await router.createWebRtcTransport({
    listenIps: [{ ip: '0.0.0.0', announcedIp: '127.0.0.1' }],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
  });
  console.log('LOG: Transport created, ID:', transport.id);
  console.log('LOG: Transport ICE parameters:', transport.iceParameters);
  console.log('LOG: Transport ICE candidates:', transport.iceCandidates);
  return transport;
}

app.get('/', (_req, res) => {
  console.log('LOG: GET / request received');
  res.send('Mediasoup server running!');
});

io.on('connection', async (socket) => {
  console.log('LOG: Client connected, socket ID:', socket.id);
  console.log('LOG: Client origin:', socket.handshake.headers.origin);
  transports[socket.id] = {};
  producers[socket.id] = [];

  // Set client role
  socket.on('setRole', ({ role }, callback) => {
    console.log('LOG: Setting role for socket:', socket.id, 'role:', role);
    roles[socket.id] = role; // 'teacher' or 'student'
    callback({ success: true });
  });

  socket.on('getRouterRtpCapabilities', (callback) => {
    console.log('LOG: Client requested router RTP capabilities');
    console.log('LOG: Sending RTP capabilities:', router.rtpCapabilities);
    callback(router.rtpCapabilities);
  });

  socket.on('createProducerTransport', async (callback) => {
    console.log('LOG: Creating producer transport for socket:', socket.id);
    transports[socket.id].producerTransport = await createWebRtcTransport();
    console.log('LOG: Producer transport created, ID:', transports[socket.id].producerTransport!.id);
    callback({
      id: transports[socket.id].producerTransport!.id,
      iceParameters: transports[socket.id].producerTransport!.iceParameters,
      iceCandidates: transports[socket.id].producerTransport!.iceCandidates,
      dtlsParameters: transports[socket.id].producerTransport!.dtlsParameters,
    });
    console.log('LOG: Producer transport data sent to client');
  });

  socket.on('connectProducerTransport', async ({ dtlsParameters }, callback) => {
    console.log('LOG: Connecting producer transport, DTLS:', dtlsParameters);
    const producerTransport = transports[socket.id].producerTransport;
    if (producerTransport) {
      try {
        await producerTransport.connect({ dtlsParameters });
        console.log('LOG: Producer transport connected, ID:', producerTransport.id);
        callback();
      } catch (error : any) {
        console.error('LOG: Error connecting producer transport:', error.message);
        callback({ error: 'Failed to connect producer transport' });
      }
    } else {
      console.error('LOG: Producer transport not found for socket:', socket.id);
      callback({ error: 'Producer transport not found' });
    }
  });

  socket.on('produce', async ({ kind, rtpParameters }, callback) => {
    console.log('LOG: Producing media, kind:', kind, 'RTP:', rtpParameters);
    const producerTransport = transports[socket.id].producerTransport;
    if (producerTransport) {
      try {
        const producer = await producerTransport.produce({ kind, rtpParameters });
        producers[socket.id].push(producer);
        console.log('LOG: Producer created, ID:', producer.id, 'Kind:', producer.kind, 'Socket:', socket.id);
        console.log('LOG: Producer state:', producer.closed);
        io.emit('producersAvailable', { socketId: socket.id, kind: producer.kind });
        console.log('LOG: Emitted producersAvailable for kind:', producer.kind);
        callback({ id: producer.id, kind: producer.kind });
      } catch (error : any) {
        console.error('LOG: Error creating producer:', error.message);
        callback({ error: 'Failed to create producer' });
      }
    } else {
      console.error('LOG: Producer transport not found for socket:', socket.id);
      callback({ error: 'Producer transport not found' });
    }
  });

  socket.on('createConsumerTransport', async (callback) => {
    console.log('LOG: Creating consumer transport for socket:', socket.id);
    transports[socket.id].consumerTransport = await createWebRtcTransport();
    console.log('LOG: Consumer transport created, ID:', transports[socket.id].consumerTransport!.id);
    callback({
      id: transports[socket.id].consumerTransport!.id,
      iceParameters: transports[socket.id].consumerTransport!.iceParameters,
      iceCandidates: transports[socket.id].consumerTransport!.iceCandidates,
      dtlsParameters: transports[socket.id].consumerTransport!.dtlsParameters,
    });
    console.log('LOG: Consumer transport data sent to client');
  });

  socket.on('connectConsumerTransport', async ({ dtlsParameters }, callback) => {
    console.log('LOG: Connecting consumer transport, DTLS:', dtlsParameters);
    const consumerTransport = transports[socket.id].consumerTransport;
    if (consumerTransport) {
      try {
        await consumerTransport.connect({ dtlsParameters });
        console.log('LOG: Consumer transport connected, ID:', consumerTransport.id);
        callback();
      } catch (error : any) {
        console.error('LOG: Error connecting consumer transport:', error.message);
        callback({ error: 'Failed to connect consumer transport' });
      }
    } else {
      console.error('LOG: Consumer transport not found for socket:', socket.id);
      callback({ error: 'Consumer transport not found' });
    }
  });

  socket.on('consume', async ({ rtpCapabilities, kind }, callback) => {
    console.log('LOG: Consuming media, kind:', kind, 'RTP capabilities:', rtpCapabilities);
    console.log('LOG: Available producers:', Object.entries(producers).map(([socketId, prods]) => ({ socketId, producers: prods.map(p => ({ id: p.id, kind: p.kind })) })));
    let producer: mediasoup.types.Producer | undefined;
    for (const socketId in producers) {
      producer = producers[socketId].find(p => p.kind === kind);
      if (producer) break;
    }
    if (!producer) {
      console.error(`LOG: Cannot consume: No ${kind} producer exists`);
      callback({ error: `No ${kind} producer exists` });
      return;
    }
    console.log(`LOG: ${kind} producer found, ID:`, producer.id);
    if (!router.canConsume({ producerId: producer.id, rtpCapabilities })) {
      console.error(`LOG: Cannot consume: Incompatible RTP capabilities for ${kind}`);
      console.log('LOG: Router RTP capabilities:', router.rtpCapabilities);
      console.log('LOG: Client RTP capabilities:', rtpCapabilities);
      callback({ error: `Incompatible RTP capabilities for ${kind}` });
      return;
    }
    const consumerTransport = transports[socket.id].consumerTransport;
    if (!consumerTransport) {
      console.error('LOG: Cannot consume: No consumer transport exists');
      callback({ error: 'No consumer transport exists' });
      return;
    }
    try {
      consumer = await consumerTransport.consume({
        producerId: producer.id,
        rtpCapabilities,
        paused: false,
      });
      console.log('LOG: Consumer created, ID:', consumer.id, 'Kind:', consumer.kind);
      console.log('LOG: Consumer state:', consumer.closed);
      callback({
        producerId: producer.id,
        id: consumer.id,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
      });
    } catch (error : any) {
      console.error('LOG: Error creating consumer:', error.message);
      callback({ error: 'Failed to create consumer' });
    }
  });

  // Chat event
  socket.on('chat', ({ message }, callback) => {
    const role = roles[socket.id] || 'Unknown';
    console.log(`LOG: Chat message received from ${role} (socket: ${socket.id}):`, message);
    io.emit('chat', { role, message });
    console.log('LOG: Broadcasted chat message:', { role, message });
    callback({ success: true });
  });

  socket.on('disconnect', () => {
    console.log('LOG: Client disconnected, socket ID:', socket.id);
    console.log('LOG: Closing producers and consumer for socket:', socket.id);
    producers[socket.id]?.forEach((producer) => producer.close());
    consumer?.close();
    transports[socket.id]?.producerTransport?.close();
    transports[socket.id]?.consumerTransport?.close();
    delete producers[socket.id];
    delete transports[socket.id];
    delete roles[socket.id];
    consumer = undefined;
    console.log('LOG: Cleanup complete for socket:', socket.id);
    io.emit('producersAvailable', { socketId: socket.id, kind: null });
  });
});

async function startServer() {
  console.log('LOG: Starting server');
  await startMediasoup();
  httpServer.listen(5000, () => {
    console.log('LOG: Server running on http://localhost:5000');
  });
}

startServer();
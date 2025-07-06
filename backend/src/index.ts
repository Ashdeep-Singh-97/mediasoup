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
let producerTransport: mediasoup.types.WebRtcTransport | undefined;
let consumerTransport: mediasoup.types.WebRtcTransport | undefined;
let producers: { [key: string]: mediasoup.types.Producer } = {};
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

  socket.on('getRouterRtpCapabilities', (callback) => {
    console.log('LOG: Client requested router RTP capabilities');
    console.log('LOG: Sending RTP capabilities:', router.rtpCapabilities);
    callback(router.rtpCapabilities);
  });

  socket.on('createProducerTransport', async (callback) => {
    console.log('LOG: Creating producer transport');
    producerTransport = await createWebRtcTransport();
    console.log('LOG: Producer transport created, ID:', producerTransport.id);
    callback({
      id: producerTransport.id,
      iceParameters: producerTransport.iceParameters,
      iceCandidates: producerTransport.iceCandidates,
      dtlsParameters: producerTransport.dtlsParameters,
    });
    console.log('LOG: Producer transport data sent to client');
  });

  socket.on('connectProducerTransport', async ({ dtlsParameters }, callback) => {
    console.log('LOG: Connecting producer transport, DTLS:', dtlsParameters);
    if (producerTransport) {
      try {
        await producerTransport.connect({ dtlsParameters });
        console.log('LOG: Producer transport connected, ID:', producerTransport.id);
        callback();
      } catch (error) {
        console.error('LOG: Error connecting producer transport:', error);
        callback({ error: 'Failed to connect producer transport' });
      }
    } else {
      console.error('LOG: Producer transport not found');
      callback({ error: 'Producer transport not found' });
    }
  });

  socket.on('produce', async ({ kind, rtpParameters }, callback) => {
    console.log('LOG: Producing media, kind:', kind, 'RTP:', rtpParameters);
    if (producerTransport) {
      try {
        const producer = await producerTransport.produce({ kind, rtpParameters });
        producers[producer.kind] = producer;
        console.log('LOG: Producer created, ID:', producer.id, 'Kind:', producer.kind);
        console.log('LOG: Producer state:', producer.closed);
        callback({ id: producer.id, kind: producer.kind });
      } catch (error) {
        console.error('LOG: Error creating producer:', error);
        callback({ error: 'Failed to create producer' });
      }
    } else {
      console.error('LOG: Producer transport not found');
      callback({ error: 'Producer transport not found' });
    }
  });

  socket.on('createConsumerTransport', async (callback) => {
    console.log('LOG: Creating consumer transport');
    consumerTransport = await createWebRtcTransport();
    console.log('LOG: Consumer transport created, ID:', consumerTransport.id);
    callback({
      id: consumerTransport.id,
      iceParameters: consumerTransport.iceParameters,
      iceCandidates: consumerTransport.iceCandidates,
      dtlsParameters: consumerTransport.dtlsParameters,
    });
    console.log('LOG: Consumer transport data sent to client');
  });

  socket.on('connectConsumerTransport', async ({ dtlsParameters }, callback) => {
    console.log('LOG: Connecting consumer transport, DTLS:', dtlsParameters);
    if (consumerTransport) {
      try {
        await consumerTransport.connect({ dtlsParameters });
        console.log('LOG: Consumer transport connected, ID:', consumerTransport.id);
        callback();
      } catch (error) {
        console.error('LOG: Error connecting consumer transport:', error);
        callback({ error: 'Failed to connect consumer transport' });
      }
    } else {
      console.error('LOG: Consumer transport not found');
      callback({ error: 'Consumer transport not found' });
    }
  });

  socket.on('consume', async ({ rtpCapabilities }, callback) => {
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
      consumer = await consumerTransport.consume({
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
    } catch (error) {
      console.error('LOG: Error creating consumer:', error);
      callback({ error: 'Failed to create consumer' });
    }
  });

  socket.on('disconnect', () => {
    console.log('LOG: Client disconnected, socket ID:', socket.id);
    console.log('LOG: Closing producers and consumer');
    Object.values(producers).forEach((producer) => producer.close());
    consumer?.close();
    producerTransport?.close();
    consumerTransport?.close();
    producers = {};
    consumer = undefined;
    producerTransport = undefined;
    consumerTransport = undefined;
    console.log('LOG: Cleanup complete');
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

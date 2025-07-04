import { useEffect, useRef, useState } from 'react';
import { Device } from 'mediasoup-client';
import io from 'socket.io-client';

// Initialize Socket.IO with explicit URL
const socket = io('http://localhost:5000', {
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 1000,
});

const App: React.FC = () => {
  const [device, setDevice] = useState<Device | null>(null);
  const [error, setError] = useState<string | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    console.log('LOG: useEffect started');
    socket.on('connect', () => {
      console.log('LOG: Socket.IO connected, ID:', socket.id);
    });
    socket.on('connect_error', (err) => {
      console.error('LOG: Socket.IO connection error:', err.message);
      setError(`Socket.IO connection failed: ${err.message}`);
    });
    socket.on('disconnect', () => {
      console.log('LOG: Socket.IO disconnected');
    });

    const initialize = async () => {
      try {
        // Step 1: Request user media
        console.log('LOG: 1. Requesting user media');
        if (!streamRef.current) {
          console.log('LOG: Calling getUserMedia');
          streamRef.current = await navigator.mediaDevices.getUserMedia({ video: true });
          console.log('LOG: User media stream obtained:', streamRef.current);
          console.log('LOG: Stream tracks:', streamRef.current.getTracks());
        }
        const stream = streamRef.current;
        if (localVideoRef.current && stream) {
          console.log('LOG: Setting local video srcObject');
          localVideoRef.current.srcObject = stream;
          if (localVideoRef.current.readyState >= 2) {
            console.log('LOG: Local video readyState sufficient, playing');
            localVideoRef.current.play().catch((err) => {
              console.error('LOG: Local video play error:', err);
              setError(`Failed to play local video: ${err.message}`);
            });
          } else {
            console.log('LOG: Waiting for local video metadata');
            localVideoRef.current.onloadedmetadata = () => {
              console.log('LOG: Local video metadata loaded, playing');
              localVideoRef.current!.play().catch((err) => {
                console.error('LOG: Local video play error:', err);
                setError(`Failed to play local video: ${err.message}`);
              });
            };
          }
        } else {
          console.log('LOG: localVideoRef or stream missing:', { localVideoRef: !!localVideoRef.current, stream: !!stream });
        }

        // Step 2: Initialize Mediasoup device
        console.log('LOG: 2. Initializing mediasoup-client Device');
        const device = new Device();
        console.log('LOG: Device created:', device);
        setDevice(device);

        // Step 3: Fetch RTP capabilities with retry
        console.log('LOG: 3. Fetching router RTP capabilities');
        let routerRtpCapabilities;
        let attempts = 0;
        const maxAttempts = 3;
        while (attempts < maxAttempts) {
          try {
            console.log(`LOG: Attempt ${attempts + 1} to fetch router RTP capabilities`);
            routerRtpCapabilities = await new Promise<any>((resolve, reject) => {
              console.log('LOG: Emitting getRouterRtpCapabilities');
              const timeout = setTimeout(() => {
                console.error('LOG: getRouterRtpCapabilities timed out');
                reject(new Error('getRouterRtpCapabilities timed out after 5s'));
              }, 5000);
              socket.emit('getRouterRtpCapabilities', (data: any) => {
                clearTimeout(timeout);
                console.log('LOG: getRouterRtpCapabilities callback received, data:', data);
                if (data) resolve(data);
                else reject(new Error('Failed to get RTP capabilities'));
              });
            });
            console.log('LOG: Router RTP capabilities received:', routerRtpCapabilities);
            break; // Success, exit loop
          } catch (error:any) {
            console.error('LOG: Attempt failed:', error.message);
            attempts++;
            if (attempts === maxAttempts) {
              throw new Error(`Failed to get RTP capabilities after ${maxAttempts} attempts`);
            }
            console.log('LOG: Retrying in 1s...');
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }

        // Step 4: Load device
        console.log('LOG: 4. Loading device with RTP capabilities');
        await device.load({ routerRtpCapabilities });
        console.log('LOG: Device loaded, canProduce video:', device.canProduce('video'));

        if (!device.canProduce('video')) {
          console.warn('LOG: Cannot produce video');
          setError('Device cannot produce video');
          return;
        }

        // Step 5: Create producer transport
        console.log('LOG: 5. Creating producer transport');
        const producerTransportData = await new Promise<any>((resolve, reject) => {
          console.log('LOG: Emitting createProducerTransport');
          const timeout = setTimeout(() => {
            console.error('LOG: createProducerTransport timed out');
            reject(new Error('createProducerTransport timed out after 5s'));
          }, 5000);
          socket.emit('createProducerTransport', (data: any) => {
            clearTimeout(timeout);
            console.log('LOG: createProducerTransport callback received, data:', data);
            if (data) resolve(data);
            else reject(new Error('Failed to create producer transport'));
          });
        });
        console.log('LOG: Producer transport data:', producerTransportData);

        const producerTransport = device.createSendTransport(producerTransportData);
        console.log('LOG: Producer transport created, ID:', producerTransport.id);

        producerTransport.on('connect', ({ dtlsParameters }, callback) => {
          console.log('LOG: 6. Producer transport connect event, DTLS:', dtlsParameters);
          socket.emit('connectProducerTransport', { dtlsParameters }, () => {
            console.log('LOG: connectProducerTransport callback received');
            callback();
          });
        });

        producerTransport.on('produce', ({ kind, rtpParameters }, callback) => {
          console.log('LOG: 7. Producing media, kind:', kind, 'RTP:', rtpParameters);
          socket.emit('produce', { kind, rtpParameters }, ({ id }: { id: string }) => {
            console.log('LOG: produce callback received, producer ID:', id);
            callback({ id });
          });
        });

        producerTransport.on('connectionstatechange', (state) => {
          console.log('LOG: Producer transport state changed:', state);
        });

        console.log('LOG: 8. Producing video track');
        const track = stream.getVideoTracks()[0];
        console.log('LOG: Video track selected:', track);
        const producer = await producerTransport.produce({ track });
        console.log('LOG: Video track produced, producer ID:', producer.id);

        // Step 9: Create consumer transport
        console.log('LOG: 9. Creating consumer transport');
        const consumerTransportData = await new Promise<any>((resolve, reject) => {
          console.log('LOG: Emitting createConsumerTransport');
          const timeout = setTimeout(() => {
            console.error('LOG: createConsumerTransport timed out');
            reject(new Error('createConsumerTransport timed out after 5s'));
          }, 5000);
          socket.emit('createConsumerTransport', (data: any) => {
            clearTimeout(timeout);
            console.log('LOG: createConsumerTransport callback received, data:', data);
            if (data) resolve(data);
            else reject(new Error('Failed to create consumer transport'));
          });
        });
        console.log('LOG: Consumer transport data:', consumerTransportData);

        const consumerTransport = device.createRecvTransport(consumerTransportData);
        console.log('LOG: Consumer transport created, ID:', consumerTransport.id);

        consumerTransport.on('connect', ({ dtlsParameters }, callback) => {
          console.log('LOG: 10. Consumer transport connect event, DTLS:', dtlsParameters);
          socket.emit('connectConsumerTransport', { dtlsParameters }, () => {
            console.log('LOG: connectConsumerTransport callback received');
            callback();
          });
        });

        consumerTransport.on('connectionstatechange', (state) => {
          console.log('LOG: Consumer transport state changed:', state);
        });

        // Delay to ensure producer is ready
        console.log('LOG: 11. Waiting 1s before consuming media');
        await new Promise((resolve) => setTimeout(resolve, 1000));

        console.log('LOG: 12. Consuming media');
        const consumerData = await new Promise<any>((resolve, reject) => {
          console.log('LOG: Emitting consume, rtpCapabilities:', device.rtpCapabilities);
          const timeout = setTimeout(() => {
            console.error('LOG: consume timed out');
            reject(new Error('consume timed out after 5s'));
          }, 5000);
          socket.emit('consume', { rtpCapabilities: device.rtpCapabilities }, (data: any) => {
            clearTimeout(timeout);
            console.log('LOG: consume callback received, data:', data);
            if (data) resolve(data);
            else reject(new Error('Failed to consume media'));
          });
        });
        console.log('LOG: Consumer data:', consumerData);

        const consumer = await consumerTransport.consume(consumerData);
        console.log('LOG: Consumer created, ID:', consumer.id);
        console.log('LOG: Consumer track state:', consumer.track.enabled, consumer.track.readyState);
        console.log('LOG: Consumer track:', consumer.track);

        const remoteStream = new MediaStream([consumer.track]);
        console.log('LOG: Remote stream created, tracks:', remoteStream.getTracks());
        if (remoteVideoRef.current) {
          console.log('LOG: Setting remote video srcObject');
          remoteVideoRef.current.srcObject = remoteStream;
          if (remoteVideoRef.current.readyState >= 2) {
            console.log('LOG: Remote video readyState sufficient, playing');
            remoteVideoRef.current.play().catch((err) => {
              console.error('LOG: Remote video play error:', err);
              setError(`Failed to play remote video: ${err.message}`);
            });
          } else {
            console.log('LOG: Waiting for remote video metadata');
            remoteVideoRef.current.onloadedmetadata = () => {
              console.log('LOG: Remote video metadata loaded, playing');
              remoteVideoRef.current!.play().catch((err) => {
                console.error('LOG: Remote video play error:', err);
                setError(`Failed to play remote video: ${err.message}`);
              });
            };
          }
        } else {
          console.log('LOG: remoteVideoRef missing');
          setError('Remote video element not found');
        }
      } catch (error:any) {
        console.error('LOG: Error in initialize:', error);
        setError(`Initialization failed: ${error.message}`);
      }
    };

    console.log('LOG: Starting initialize');
    initialize();

    return () => {
      console.log('LOG: Cleaning up, disconnecting socket');
      socket.off('connect');
      socket.off('connect_error');
      socket.off('disconnect');
      if (streamRef.current) {
        console.log('LOG: Stopping media tracks');
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
      socket.disconnect();
    };
  }, []);

  return (
    <div>
      <h1>Mediasoup Video Demo</h1>
      {error && <p style={{ color: 'red' }}>{error}</p>}
      <div style={{ display: 'flex', gap: '20px' }}>
        <div>
          <h3>Local Video</h3>
          <video ref={localVideoRef} autoPlay playsInline muted style={{ width: '300px' }} />
        </div>
        <div>
          <h3>Remote Video</h3>
          <video ref={remoteVideoRef} autoPlay playsInline style={{ width: '300px' }} />
        </div>
      </div>
    </div>
  );
};

export default App;

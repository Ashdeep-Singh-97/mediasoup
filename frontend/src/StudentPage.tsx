import React, { useEffect, useRef, useState } from 'react';
import { Device, types } from 'mediasoup-client';
import io from 'socket.io-client';

const socket = io('http://localhost:5000', {
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 1000,
});

interface ChatMessage {
  role: string;
  message: string;
}

const StudentPage: React.FC = () => {
  const [device, setDevice] = useState<Device | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [consumerTransport, setConsumerTransport] = useState<types.Transport | null>(null);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState<string>('');
  const remoteVideoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    console.log('LOG: StudentPage useEffect [initialize] started');
    socket.on('connect', () => {
      console.log('LOG: Socket.IO connected, ID:', socket.id);
      socket.emit('setRole', { role: 'student' }, ({ success }: { success: boolean }) => {
        console.log('LOG: Role set to student, success:', success);
      });
    });
    socket.on('connect_error', (err) => {
      console.error('LOG: Socket.IO connection error:', err.message);
      setError(`Socket.IO connection failed: ${err.message}`);
    });
    socket.on('disconnect', () => {
      console.log('LOG: Socket.IO disconnected');
    });

    socket.on('chat', ({ role, message }) => {
      console.log('LOG: Chat message received:', { role, message });
      setMessages((prev) => [...prev, { role, message }]);
    });

    const initialize = async () => {
      try {
        console.log('LOG: 1. Initializing mediasoup-client Device');
        const device = new Device();
        console.log('LOG: Device created:', device);
        setDevice(device);

        console.log('LOG: 2. Fetching router RTP capabilities');
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
            break;
          } catch (error : any) {
            console.error('LOG: Attempt failed:', error.message);
            attempts++;
            if (attempts === maxAttempts) {
              throw new Error(`Failed to get RTP capabilities after ${maxAttempts} attempts`);
            }
            console.log('LOG: Retrying in 1s...');
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }

        console.log('LOG: 3. Loading device with RTP capabilities');
        try {
          await device.load({ routerRtpCapabilities });
          console.log('LOG: Device loaded, canConsume:', device.rtpCapabilities);
        } catch (err : any) {
          console.error('LOG: Device load failed:', err);
          setError(`Device load failed: ${err.message}`);
          return;
        }

        console.log('LOG: 4. Creating consumer transport');
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

        const transport = device.createRecvTransport(consumerTransportData);
        console.log('LOG: Consumer transport created, ID:', transport.id);

        transport.on('connect', ({ dtlsParameters }, callback) => {
          console.log('LOG: 5. Consumer transport connect event, DTLS:', dtlsParameters);
          socket.emit('connectConsumerTransport', { dtlsParameters }, () => {
            console.log('LOG: connectConsumerTransport callback received');
            callback();
          });
        });

        transport.on('connectionstatechange', (state) => {
          console.log('LOG: Consumer transport state changed:', state);
        });

        setConsumerTransport(transport);
      } catch (error : any) {
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
      socket.off('chat');
      socket.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!device || !consumerTransport) {
      console.log('LOG: Waiting for device and consumerTransport, device:', !!device, 'consumerTransport:', !!consumerTransport);
      return;
    }

    console.log('LOG: Device and consumerTransport ready, starting consumeMedia');

    const consumeMedia = async (kind: 'video' | 'audio') => {
      console.log(`LOG: Starting consumeMedia for ${kind}`);
      let attempts = 0;
      const maxAttempts = 5;
      while (attempts < maxAttempts) {
        try {
          console.log(`LOG: Attempt ${attempts + 1} to consume ${kind}`);
          const consumerData = await new Promise<any>((resolve, reject) => {
            console.log(`LOG: Emitting consume for ${kind}, rtpCapabilities:`, device.rtpCapabilities);
            const timeout = setTimeout(() => {
              console.error(`LOG: ${kind} consume timed out`);
              reject(new Error(`${kind} consume timed out after 5s`));
            }, 5000);
            socket.emit('consume', { rtpCapabilities: device.rtpCapabilities, kind }, (data: any) => {
              clearTimeout(timeout);
              console.log(`LOG: ${kind} consume callback received, data:`, data);
              if (data && !data.error) resolve(data);
              else reject(new Error(data?.error || `Failed to consume ${kind}`));
            });
          });
          console.log(`LOG: ${kind} consumer data:`, consumerData);

          const consumer = await consumerTransport.consume(consumerData);
          console.log(`LOG: ${kind} consumer created, ID:`, consumer.id);
          console.log(`LOG: ${kind} consumer track state:`, consumer.track.enabled, consumer.track.readyState);
          console.log(`LOG: ${kind} consumer track:`, consumer.track);

          const remoteStream = new MediaStream([consumer.track]);
          console.log('LOG: Remote stream created, tracks:', remoteStream.getTracks());
          if (remoteVideoRef.current) {
            console.log('LOG: Setting remote video srcObject');
            remoteVideoRef.current.srcObject = remoteStream;
            console.log('LOG: Remote video ready, waiting for user to start playback');
          } else {
            console.log('LOG: remoteVideoRef missing');
            setError('Remote video element not found');
          }
          break;
        } catch (error : any) {
          console.error(`LOG: Error consuming ${kind}:`, error.message);
          attempts++;
          if (attempts === maxAttempts) {
            setError(`Failed to consume ${kind} after ${maxAttempts} attempts`);
            return;
          }
          console.log(`LOG: Retrying ${kind} consume in 2s...`);
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    };

    socket.on('producersAvailable', ({ socketId, kind }) => {
      console.log('LOG: producersAvailable received, socketId:', socketId, 'kind:', kind);
      if (kind === 'video') {
        consumeMedia('video');
      }
    });

    consumeMedia('video');

    return () => {
      console.log('LOG: Cleaning up consumeMedia');
      socket.off('producersAvailable');
    };
  }, [device, consumerTransport]);

  const startPlayback = () => {
    if (remoteVideoRef.current) {
      console.log('LOG: Starting video playback on user interaction');
      remoteVideoRef.current.play().then(() => {
        console.log('LOG: Remote video playback started');
        setIsPlaying(true);
      }).catch((err) => {
        console.error('LOG: Remote video play error:', err);
        setError(`Failed to play remote video: ${err.message}`);
      });
    } else {
      console.error('LOG: remoteVideoRef missing on startPlayback');
      setError('Remote video element not found');
    }
  };

  const sendMessage = () => {
    if (chatInput.trim()) {
      console.log('LOG: Sending chat message:', chatInput);
      socket.emit('chat', { message: chatInput }, ({ success }: { success: boolean }) => {
        console.log('LOG: Chat message sent, success:', success);
      });
      setChatInput('');
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && chatInput.trim()) {
      sendMessage();
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <h1>Student Dashboard</h1>
      {error && <p style={{ color: 'red' }}>{error}</p>}
      <div>
        <h3>Teacher's Video</h3>
        <video ref={remoteVideoRef} autoPlay={false} playsInline muted={true} style={{ width: '300px' }} />
        {!isPlaying && (
          <button onClick={startPlayback} style={{ marginTop: '10px' }}>
            Start Watching
          </button>
        )}
      </div>
      <div style={{ width: '600px', border: '1px solid #ccc', padding: '10px' }}>
        <h3>Chat</h3>
        <div style={{ height: '200px', overflowY: 'auto', border: '1px solid #ddd', padding: '10px', marginBottom: '10px' }}>
          {messages.map((msg, index) => (
            <div key={index}>
              <strong>{msg.role}:</strong> {msg.message}
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: '10px' }}>
          <input
            type="text"
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="Type a message..."
            style={{ flex: 1, padding: '5px' }}
          />
          <button onClick={sendMessage}>Send</button>
        </div>
      </div>
    </div>
  );
};

export default StudentPage;
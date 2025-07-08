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

const TeacherPage: React.FC = () => {
  const [device, setDevice] = useState<Device | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [muteVideo, setMuteVideo] = useState<boolean>(false);
  const [muteAudio, setMuteAudio] = useState<boolean>(false);
  const [screenSharing, setScreenSharing] = useState<boolean>(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState<string>('');
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const videoProducerRef = useRef<types.Producer | null>(null);
  const audioProducerRef = useRef<types.Producer | null>(null);

  useEffect(() => {
    console.log('LOG: TeacherPage useEffect started');
    socket.on('connect', () => {
      console.log('LOG: Socket.IO connected, ID:', socket.id);
      socket.emit('setRole', { role: 'teacher' }, ({ success }: { success: boolean }) => {
        console.log('LOG: Role set to teacher, success:', success);
      });
    });
    socket.on('connect_error', (err) => {
      console.error('LOG: Socket.IO connection error:', err.message);
      setError(`Socket.IO connection failed: ${err.message}`);
    });
    socket.on('disconnect', () => {
      console.log('LOG: Socket.IO disconnected');
    });

    // Listen for chat messages
    socket.on('chat', ({ role, message }) => {
      console.log('LOG: Chat message received:', { role, message });
      setMessages((prev) => [...prev, { role, message }]);
    });

    const initialize = async () => {
      try {
        console.log('LOG: 1. Requesting user media');
        if (!streamRef.current) {
          console.log('LOG: Calling getUserMedia');
          try {
            streamRef.current = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            console.log('LOG: User media stream obtained:', streamRef.current);
            console.log('LOG: Stream tracks:', streamRef.current.getTracks());
          } catch (err : any) {
            console.error('LOG: getUserMedia failed:', err);
            setError(`Failed to get user media: ${err.message}`);
            return;
          }
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
          setError('Local video element or stream missing');
          return;
        }

        console.log('LOG: 2. Initializing mediasoup-client Device');
        const device = new Device();
        console.log('LOG: Device created:', device);
        setDevice(device);

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

        console.log('LOG: 4. Loading device with RTP capabilities');
        try {
          await device.load({ routerRtpCapabilities });
          console.log('LOG: Device loaded, canProduce video:', device.canProduce('video'), 'canProduce audio:', device.canProduce('audio'));
        } catch (err : any) {
          console.error('LOG: Device load failed:', err);
          setError(`Device load failed: ${err.message}`);
          return;
        }

        if (!device.canProduce('video') || !device.canProduce('audio')) {
          console.warn('LOG: Cannot produce video or audio');
          setError('Device cannot produce video or audio');
          return;
        }

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
          socket.emit('produce', { kind, rtpParameters }, ({ id, kind: producerKind }: { id: string; kind: string }) => {
            console.log('LOG: produce callback received, producer ID:', id, 'kind:', producerKind);
            callback({ id });
          });
        });

        producerTransport.on('connectionstatechange', (state) => {
          console.log('LOG: Producer transport state changed:', state);
        });

        console.log('LOG: 8. Producing video and audio tracks');
        const videoTrack = stream.getVideoTracks()[0];
        const audioTrack = stream.getAudioTracks()[0];
        console.log('LOG: Video track selected:', videoTrack);
        console.log('LOG: Audio track selected:', audioTrack);

        if (videoTrack) {
          videoProducerRef.current = await producerTransport.produce({ track: videoTrack });
          console.log('LOG: Video producer created, ID:', videoProducerRef.current.id, 'state:', videoProducerRef.current.closed);
        } else {
          console.warn('LOG: No video track available');
          setError('No video track available');
        }

        if (audioTrack) {
          audioProducerRef.current = await producerTransport.produce({ track: audioTrack });
          console.log('LOG: Audio producer created, ID:', audioProducerRef.current.id, 'state:', audioProducerRef.current.closed);
        } else {
          console.warn('LOG: No audio track available');
          setError('No audio track available');
        }

        if (!videoProducerRef.current && !audioProducerRef.current) {
          console.error('LOG: No producers created');
          setError('Failed to create any producers');
          return;
        }

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

        if (videoProducerRef.current) {
          console.log('LOG: 11. Consuming video');
          const videoConsumerData = await new Promise<any>((resolve, reject) => {
            console.log('LOG: Emitting consume for video, rtpCapabilities:', device.rtpCapabilities);
            const timeout = setTimeout(() => {
              console.error('LOG: Video consume timed out');
              reject(new Error('Video consume timed out after 5s'));
            }, 5000);
            socket.emit('consume', { rtpCapabilities: device.rtpCapabilities, kind: 'video' }, (data: any) => {
              clearTimeout(timeout);
              console.log('LOG: Video consume callback received, data:', data);
              if (data && !data.error) resolve(data);
              else reject(new Error(data?.error || 'Failed to consume video'));
            });
          });
          console.log('LOG: Video consumer data:', videoConsumerData);

          const videoConsumer = await consumerTransport.consume(videoConsumerData);
          console.log('LOG: Video consumer created, ID:', videoConsumer.id);
          console.log('LOG: Video consumer track state:', videoConsumer.track.enabled, videoConsumer.track.readyState);
          console.log('LOG: Video consumer track:', videoConsumer.track);

          const remoteStream = new MediaStream([videoConsumer.track]);
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
        }
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
      if (streamRef.current) {
        console.log('LOG: Stopping media tracks');
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
      socket.disconnect();
    };
  }, []);

  const toggleVideo = () => {
    if (streamRef.current && videoProducerRef.current) {
      const videoTrack = streamRef.current.getVideoTracks()[0];
      if (videoTrack) {
        console.log('LOG: Toggling video, current enabled:', videoTrack.enabled);
        videoTrack.enabled = !videoTrack.enabled;
        setMuteVideo(!videoTrack.enabled);
        console.log('LOG: Video track enabled set to:', videoTrack.enabled);
        if (videoProducerRef.current) {
          if (videoTrack.enabled) {
            videoProducerRef.current.resume();
            console.log('LOG: Video producer resumed');
          } else {
            videoProducerRef.current.pause();
            console.log('LOG: Video producer paused');
          }
        }
      } else {
        console.error('LOG: No video track found');
        setError('No video track found');
      }
    } else {
      console.error('LOG: Stream or video producer missing');
      setError('Stream or video producer missing');
    }
  };

  const toggleAudio = () => {
    if (streamRef.current && audioProducerRef.current) {
      const audioTrack = streamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        console.log('LOG: Toggling audio, current enabled:', audioTrack.enabled);
        audioTrack.enabled = !audioTrack.enabled;
        setMuteAudio(!audioTrack.enabled);
        console.log('LOG: Audio track enabled set to:', audioTrack.enabled);
        if (audioProducerRef.current) {
          if (audioTrack.enabled) {
            audioProducerRef.current.resume();
            console.log('LOG: Audio producer resumed');
          } else {
            audioProducerRef.current.pause();
            console.log('LOG: Audio producer paused');
          }
        }
      } else {
        console.error('LOG: No audio track found');
        setError('No audio track found');
      }
    } else {
      console.error('LOG: Stream or audio producer missing');
      setError('Stream or audio producer missing');
    }
  };

  const toggleScreenShare = async () => {
    if (!device || !videoProducerRef.current) {
      console.error('LOG: Device or video producer missing');
      setError('Device or video producer missing');
      return;
    }

    try {
      if (screenSharing) {
        console.log('LOG: Switching back to camera');
        const newStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        const newVideoTrack = newStream.getVideoTracks()[0];
        const newAudioTrack = newStream.getAudioTracks()[0];
        console.log('LOG: New camera stream obtained:', newStream);
        console.log('LOG: New video track:', newVideoTrack);
        console.log('LOG: New audio track:', newAudioTrack);

        if (streamRef.current) {
          console.log('LOG: Stopping old media tracks');
          streamRef.current.getTracks().forEach((track) => track.stop());
        }

        streamRef.current = newStream;
        if (localVideoRef.current) {
          console.log('LOG: Setting local video srcObject to camera stream');
          localVideoRef.current.srcObject = newStream;
          localVideoRef.current.play().catch((err) => {
            console.error('LOG: Camera video play error:', err);
            setError(`Failed to play camera video: ${err.message}`);
          });
        }

        if (newVideoTrack && videoProducerRef.current) {
          console.log('LOG: Replacing video track in producer');
          await videoProducerRef.current.replaceTrack({ track: newVideoTrack });
          console.log('LOG: Video track replaced');
        }

        setScreenSharing(false);
        setMuteVideo(false);
        setMuteAudio(false);
      } else {
        console.log('LOG: Starting screen sharing');
        const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const screenTrack = screenStream.getVideoTracks()[0];
        console.log('LOG: Screen stream obtained:', screenStream);
        console.log('LOG: Screen video track:', screenTrack);

        if (streamRef.current) {
          console.log('LOG: Stopping old media tracks');
          streamRef.current.getTracks().forEach((track) => track.stop());
        }

        streamRef.current = screenStream;
        if (localVideoRef.current) {
          console.log('LOG: Setting local video srcObject to screen stream');
          localVideoRef.current.srcObject = screenStream;
          localVideoRef.current.play().catch((err) => {
            console.error('LOG: Screen video play error:', err);
            setError(`Failed to play screen video: ${err.message}`);
          });
        }

        if (screenTrack && videoProducerRef.current) {
          console.log('LOG: Replacing video track in producer with screen track');
          await videoProducerRef.current.replaceTrack({ track: screenTrack });
          console.log('LOG: Screen track replaced');
        }

        screenTrack.onended = async () => {
          console.log('LOG: Screen sharing ended, switching back to camera');
          await toggleScreenShare();
        };

        setScreenSharing(true);
        setMuteVideo(false);
      }
    } catch (error : any) {
      console.error('LOG: Error in toggleScreenShare:', error);
      setError(`Failed to toggle screen sharing: ${error.message}`);
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
      <h1>Teacher Dashboard</h1>
      {error && <p style={{ color: 'red' }}>{error}</p>}
      <div style={{ display: 'flex', gap: '20px' }}>
        <div>
          <h3>Teacher's Video (Local)</h3>
          <video ref={localVideoRef} autoPlay playsInline muted={false} style={{ width: '300px' }} />
          <div style={{ marginTop: '10px', display: 'flex', gap: '10px' }}>
            <button onClick={toggleVideo}>
              {muteVideo ? 'Unmute Video' : 'Mute Video'}
            </button>
            <button onClick={toggleAudio}>
              {muteAudio ? 'Unmute Audio' : 'Mute Audio'}
            </button>
            <button onClick={toggleScreenShare}>
              {screenSharing ? 'Stop Screen Share' : 'Start Screen Share'}
            </button>
          </div>
        </div>
        <div>
          <h3>Remote Video (Mirror)</h3>
          <video ref={remoteVideoRef} autoPlay playsInline muted={false} style={{ width: '300px' }} />
        </div>
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

export default TeacherPage;
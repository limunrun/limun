use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;

#[tokio::main]
async fn main() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:8787").await.unwrap();
    println!("WS echo server listening on 127.0.0.1:8787");

    while let Ok((stream, _)) = listener.accept().await {
        tokio::spawn(async move {
            let mut ws = match tokio_tungstenite::accept_async(stream).await {
                Ok(ws) => ws,
                Err(e) => {
                    eprintln!("WS accept error: {e}");
                    return;
                }
            };

            let mut protocol_echo = false;

            while let Some(msg_result) = ws.next().await {
                match msg_result {
                    Ok(msg) => {
                        match &msg {
                            Message::Text(_) => {}
                            Message::Binary(_) => {}
                            Message::Close(_) => break,
                            _ => {}
                        }
                        if !protocol_echo {
                            protocol_echo = true;
                        }
                        let _ = ws.send(msg).await;
                    }
                    Err(e) => {
                        eprintln!("WS error: {e}");
                        break;
                    }
                }
            }
        });
    }
}
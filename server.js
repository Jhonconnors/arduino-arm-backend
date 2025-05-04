const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");
const fs = require("fs");

const app = express();
const server = http.createServer(app);

const path = require("path");

function playFromTxt(filePath, port) {
    const fullPath = path.resolve(filePath);
    const content = fs.readFileSync(fullPath, "utf-8");

    const lines = content.split("\n").filter(line => line.trim().length > 0);
    
    // Reproducir línea por línea con delay
    let i = 0;

    const playNext = () => {
        if (i >= lines.length) return;

        const [servo, angle, speed] = lines[i].split(",").map(Number);
        if (!isNaN(servo) && !isNaN(angle) && !isNaN(speed)) {
            const command = `${servo},${angle},${speed}\n`;
            port.write(command);
            console.log(`▶️ Ejecutando: ${command.trim()}`);
        }

        i++;
        setTimeout(playNext, 1000); // delay entre comandos
    };

    playNext();
}


app.use(cors({
    origin: "http://localhost:3000",
    methods: ["GET", "POST"]
}));

const io = new Server(server, {
    cors: {
        origin: "http://localhost:3000",
        methods: ["GET", "POST"]
    }
});

app.use(express.static("public"));

let sequences = [];

async function findArduinoPort() {
    try {
        const ports = await SerialPort.list();
        if (ports.length === 0) {
            console.error("⚠️ No se encontraron puertos disponibles.");
            process.exit(1);
        }

        const arduinoPort = ports.find(port =>
            port.manufacturer && port.manufacturer.includes("Arduino")
        );

        if (arduinoPort) {
            console.log(`✅ Arduino encontrado en: ${arduinoPort.path}`);
            return arduinoPort.path;
        } else {
            console.warn("⚠️ No se identificó un puerto de Arduino. Usando el primer puerto disponible.");
            return ports[0].path;
        }
    } catch (error) {
        console.error("❌ Error al listar puertos:", error);
        process.exit(1);
    }
}

(async () => {
    const portName = await findArduinoPort();
    const port = new SerialPort({ path: portName, baudRate: 9600 });
    const parser = port.pipe(new ReadlineParser({ delimiter: "\n" }));

    port.on("open", () => console.log("✅ Conexión con Arduino establecida"));
    port.on("error", err => console.error("❌ Error en el puerto serial:", err));

    parser.on("data", (line) => {
        console.log("📩 Arduino dice:", line);
        if (line.startsWith("SEQUENCE_START")) {
            sequences = [];
        } else if (line.startsWith("SEQUENCE_END")) {
            fs.writeFileSync("sequences.json", JSON.stringify(sequences, null, 2));
            console.log("✅ Secuencia guardada en sequences.json");
        } else if (line.startsWith("SEQUENCE,")) {
            const [servo, angle, speed] = line.replace("SEQUENCE,", "").split(",").map(Number);
            sequences.push([{ servo, angle, speed }]); // cada paso como array de objetos
        }
    });

    io.on("connection", (socket) => {
        console.log("Cliente conectado");

        socket.on("importTxt", (txtContent) => {
            const filePath = "movimientos_importados.txt";
            
            // Guardamos el contenido del archivo
            fs.writeFileSync(filePath, txtContent, "utf-8");
            console.log("📥 Archivo TXT importado correctamente.");
        
            // Reproducimos la secuencia desde el archivo
            playFromTxt(filePath, port);
        });

        socket.on("move", (data) => {
            console.log(`📤 Enviando comando: ${data.servo},${data.angle},${data.speed}`);
            port.write(`${data.servo},${data.angle},${data.speed}\n`);
        });

        socket.on("saveSequence", (sequence) => {
            sequences.push(sequence); // asumimos que sequence es un array de objetos
            fs.writeFileSync("sequences.json", JSON.stringify(sequences, null, 2));
            console.log("✅ Secuencia guardada manualmente");
        });

        socket.on("getSequences", () => {
            socket.emit("sequencesList", sequences);
        });

        socket.on("playSequence", () => {
            if (sequences.length === 0) {
                console.log("⚠️ No hay secuencias guardadas.");
                return;
            }

            console.log("▶️ Posicionando servos en 90° antes de iniciar...");
            for (let i = 1; i <= 6; i++) {
                const command = `${i},90,5\n`;
                console.log(`📤 Enviando: ${command}`);
                port.write(command);
            }

            setTimeout(() => {
                console.log("▶️ Reproduciendo secuencia...");
                let stepIndex = 0;

                function sendNextStep() {
                    if (stepIndex < sequences.length) {
                        sequences[stepIndex].forEach(({ servo, angle, speed }) => {
                            const command = `${servo},${angle},${speed}\n`;
                            console.log(`📤 Enviando: ${command}`);
                            port.write(command);
                        });
                        const delay = sequences[stepIndex][0].speed * 50;
                        stepIndex++;
                        setTimeout(sendNextStep, delay);
                    }
                }

                sendNextStep();
            }, 2000);
        });

        socket.on("downloadTxt", () => {
            const data = sequences.map(seq =>
                seq.map(step => `${step.servo},${step.angle},${step.speed}`).join("\n")
            ).join("\n\n");
            fs.writeFileSync("sequences.txt", data);
            socket.emit("txtReady", "sequences.txt");
        });

        socket.on("disconnect", () => {
            console.log("Cliente desconectado");
        });
    });
})();

// app.get("/downloadTxt", (req, res) => {
//     res.download(__dirname + "/sequences.txt");
// });

server.listen(3001, () => {
    console.log("🚀 Servidor corriendo en http://localhost:3001");
});

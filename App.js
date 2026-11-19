// This code was generated with the help of Claude. 
// It was tested and debugged by our team and Claude.


import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Keyboard,
  Platform,
  useWindowDimensions,
} from "react-native";
import { Accelerometer } from "expo-sensors";
import AsyncStorage from "@react-native-async-storage/async-storage";

// ---------- Game constants ----------
const ROWS = 13; // tiles (odd numbers so the maze carving works)
const COLS = 11;
const BLUE_PTS = 50;
const RED_PTS = 70;
const LEVEL_PTS = [100, 200, 300];
const BLUE_COUNT = [1, 2, 2]; // hearts per maze
const RED_COUNT = [1, 1, 2];
const STORAGE_KEY = "amazeing_scores";
const LEVEL_COLORS = ["#7ac70c", "#ff5a5a", "#37c4f0"];

// ---------- Maze generation (seeded, so each level is always the same
// layout and always has a reachable exit: depth-first "recursive backtracker") ----------
function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function shuffle(arr, rnd) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function makeMaze(level) {
  const rnd = seededRandom(level * 7919 + 13);
  const grid = Array.from({ length: ROWS }, () => Array(COLS).fill("#"));

  // carve passages
  grid[1][1] = ".";
  const stack = [[1, 1]];
  while (stack.length) {
    const [r, c] = stack[stack.length - 1];
    const options = shuffle([[0, 2], [0, -2], [2, 0], [-2, 0]], rnd).filter(
      ([dr, dc]) => {
        const nr = r + dr;
        const nc = c + dc;
        return nr > 0 && nr < ROWS - 1 && nc > 0 && nc < COLS - 1 && grid[nr][nc] === "#";
      }
    );
    if (options.length === 0) {
      stack.pop();
    } else {
      const [dr, dc] = options[0];
      grid[r + dr / 2][c + dc / 2] = ".";
      grid[r + dr][c + dc] = ".";
      stack.push([r + dr, c + dc]);
    }
  }

  // exit = the open cell farthest from the start (BFS)
  const dist = {};
  const queue = [[1, 1]];
  dist["1,1"] = 0;
  let exit = [1, 1];
  while (queue.length) {
    const [r, c] = queue.shift();
    if (dist[`${r},${c}`] > dist[`${exit[0]},${exit[1]}`]) exit = [r, c];
    for (const [dr, dc] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const nr = r + dr;
      const nc = c + dc;
      if (grid[nr][nc] === "." && dist[`${nr},${nc}`] === undefined) {
        dist[`${nr},${nc}`] = dist[`${r},${c}`] + 1;
        queue.push([nr, nc]);
      }
    }
  }

  // hearts on random open cells (not start / exit) -> always reachable
  const open = [];
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) {
      const isStart = r === 1 && c === 1;
      const isExit = r === exit[0] && c === exit[1];
      if (grid[r][c] === "." && !isStart && !isExit) open.push([r, c]);
    }
  shuffle(open, rnd);
  const items = [];
  const nBlue = BLUE_COUNT[level - 1];
  const nRed = RED_COUNT[level - 1];
  for (let i = 0; i < nBlue + nRed; i++) {
    items.push({ r: open[i][0], c: open[i][1], type: i < nBlue ? "blue" : "red" });
  }

  return { grid, start: [1, 1], exit, items };
}

// true if the ball (circle approximated by a box of radius rad) touches a wall tile
function hitsWall(grid, cs, rad, x, y) {
  for (const dx of [-rad, rad])
    for (const dy of [-rad, rad]) {
      const row = grid[Math.floor((y + dy) / cs)];
      if (!row || row[Math.floor((x + dx) / cs)] !== ".") return true;
    }
  return false;
}

// Static walls drawn once per level (memoized so they don't redraw every frame)
const Walls = React.memo(function Walls({ grid, cs, color }) {
  const tiles = [];
  grid.forEach((row, r) =>
    row.forEach((cell, c) => {
      if (cell === "#")
        tiles.push(
          <View
            key={`${r}-${c}`}
            style={{
              position: "absolute",
              left: c * cs,
              top: r * cs,
              width: cs,
              height: cs,
              backgroundColor: color,
              borderWidth: 0.5,
              borderColor: "rgba(0,0,0,0.25)",
            }}
          />
        );
    })
  );
  return <>{tiles}</>;
});

export default function App() {
  const { width, height } = useWindowDimensions();
  const cs = Math.floor(Math.min((width - 16) / COLS, (height * 0.45) / ROWS));
  const ballR = cs * 0.3;

  const levels = useMemo(() => [1, 2, 3].map(makeMaze), []);

  // game state
  const [level, setLevel] = useState(1);
  const [finished, setFinished] = useState(false);
  const [blue, setBlue] = useState(0);
  const [red, setRed] = useState(0);
  const [levelPts, setLevelPts] = useState(0);
  const [collected, setCollected] = useState([]); // keys of hearts already taken
  const [ball, setBall] = useState({ x: 0, y: 0 });

  // saving / leaderboard state
  const [name, setName] = useState("");
  const [scores, setScores] = useState([]);
  const [saved, setSaved] = useState(false);

  // refs for physics (no re-render needed)
  const accRef = useRef({ x: 0, y: 0, z: 0 });
  const pos = useRef({ x: 0, y: 0 });
  const vel = useRef({ x: 0, y: 0 });
  const got = useRef(new Set());

  // refs/state for keeping the name box visible above the keyboard
  const scrollRef = useRef(null);
  const scrollY = useRef(0); // current scroll offset
  const savedY = useRef(0); // offset to return to when the keyboard closes
  const saveRowY = useRef(0); // y position of the name box / Save Score row
  const kbOpen = useRef(false);
  const pendingScroll = useRef(false);
  const [kbHeight, setKbHeight] = useState(0);

  const scrollToNameBox = () => {
    // scrolling to the very end always works: it shows the name box, Save Score and Top 3
    scrollRef.current?.scrollToEnd({ animated: true });
  };

  const maze = levels[level - 1];
  const total = blue * BLUE_PTS + red * RED_PTS + levelPts;

  // ----- load saved scores on startup -----
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((v) => v && setScores(JSON.parse(v)))
      .catch(() => {});
  }, []);

  // ----- accelerometer -----
  useEffect(() => {
    Accelerometer.setUpdateInterval(16);
    const sub = Accelerometer.addListener((d) => (accRef.current = d));
    return () => sub.remove();
  }, []);

  // ----- keyboard: scroll the name box above the keyboard, then back down -----
  useEffect(() => {
    const showEvt = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvt = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";

    const showSub = Keyboard.addListener(showEvt, (e) => {
      if (!kbOpen.current) savedY.current = scrollY.current; // remember where the player was
      kbOpen.current = true;
      pendingScroll.current = true; // scroll as soon as the extra padding has been laid out
      setKbHeight(e.endCoordinates.height); // adds room at the bottom of the scroll area
      setTimeout(() => {
        // fallback in case the content size did not change
        pendingScroll.current = false;
        scrollToNameBox();
      }, 400);
    });
    const hideSub = Keyboard.addListener(hideEvt, () => {
      kbOpen.current = false;
      pendingScroll.current = false;
      scrollRef.current?.scrollTo({ y: savedY.current, animated: true });
      setKbHeight(0);
    });

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  // ----- game loop (restarts when the level changes) -----
  useEffect(() => {
    if (finished) return;

    // put the ball on the start cell
    pos.current = { x: maze.start[1] * cs + cs / 2, y: maze.start[0] * cs + cs / 2 };
    vel.current = { x: 0, y: 0 };
    setBall({ ...pos.current });

    let done = false;
    let last = Date.now();
    let raf;
    const kAccel = 900; // tilt strength
    const friction = 3; // damping
    const bounce = 0.3;
    const maxSpeed = cs * 7; // keeps a single frame step smaller than a wall tile

    const step = () => {
      // pause the game while the keyboard is open so the screen stays still while typing
      if (kbOpen.current) {
        last = Date.now();
        raf = requestAnimationFrame(step);
        return;
      }
      const now = Date.now();
      const dt = Math.min((now - last) / 1000, 0.033);
      last = now;

      const damping = Math.exp(-friction * dt);
      let vx = (vel.current.x + accRef.current.x * kAccel * dt) * damping;
      let vy = (vel.current.y - accRef.current.y * kAccel * dt) * damping;
      vx = Math.max(-maxSpeed, Math.min(maxSpeed, vx));
      vy = Math.max(-maxSpeed, Math.min(maxSpeed, vy));

      let { x, y } = pos.current;

      // move one axis at a time so the ball slides along walls
      if (hitsWall(maze.grid, cs, ballR, x + vx * dt, y)) vx = -vx * bounce;
      else x += vx * dt;
      if (hitsWall(maze.grid, cs, ballR, x, y + vy * dt)) vy = -vy * bounce;
      else y += vy * dt;

      pos.current = { x, y };
      vel.current = { x: vx, y: vy };
      setBall({ x, y });

      // collect hearts (each only once)
      maze.items.forEach((it) => {
        const key = `${level}-${it.r}-${it.c}`;
        if (got.current.has(key)) return;
        const cx = it.c * cs + cs / 2;
        const cy = it.r * cs + cs / 2;
        if (Math.hypot(x - cx, y - cy) < cs * 0.45) {
          got.current.add(key);
          setCollected((prev) => [...prev, key]);
          if (it.type === "blue") setBlue((b) => b + 1);
          else setRed((r) => r + 1);
        }
      });

      // reached the exit?
      const ex = maze.exit[1] * cs + cs / 2;
      const ey = maze.exit[0] * cs + cs / 2;
      if (!done && Math.hypot(x - ex, y - ey) < cs * 0.4) {
        done = true;
        setLevelPts((p) => p + LEVEL_PTS[level - 1]);
        if (level < 3) setLevel(level + 1);
        else setFinished(true);
        return; // stop this loop
      }

      raf = requestAnimationFrame(step);
    };

    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [level, cs, finished]);

  // ----- save score -----
  const saveScore = async () => {
    if (!name.trim()) return;
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      const list = raw ? JSON.parse(raw) : [];
      list.push({ name: name.trim(), score: total });
      list.sort((a, b) => b.score - a.score);
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(list));
      setScores(list);
      setSaved(true);
    } catch (e) {
      console.warn("Could not save score", e);
    }
  };

  const restart = () => {
    got.current = new Set();
    setCollected([]);
    setBlue(0);
    setRed(0);
    setLevelPts(0);
    setSaved(false);
    setFinished(false);
    setLevel(1);
  };

  const mono = Platform.select({ ios: "Courier New", android: "monospace", default: "monospace" });
  const color = LEVEL_COLORS[level - 1];

  return (
    <ScrollView
      ref={scrollRef}
      style={{ flex: 1, backgroundColor: "#111" }}
      contentContainerStyle={{ paddingTop: 36, paddingBottom: 36 + kbHeight, alignItems: "center" }}
      keyboardShouldPersistTaps="handled"
      scrollEventThrottle={16}
      onContentSizeChange={() => {
        if (pendingScroll.current) {
          pendingScroll.current = false;
          scrollToNameBox();
        }
      }}
      onScroll={(e) => (scrollY.current = e.nativeEvent.contentOffset.y)}
    >
      {/* Header */}
      <View style={{ width: COLS * cs, flexDirection: "row", justifyContent: "space-between", marginBottom: 6 }}>
        <Text style={{ color: "#fff", fontSize: 26, fontWeight: "bold" }}>aMAZEing</Text>
        <Text style={{ color, fontSize: 26, fontWeight: "bold" }}>L{level}</Text>
      </View>

      {/* Maze */}
      <View style={{ width: COLS * cs, height: ROWS * cs, backgroundColor: "#222" }}>
        <Walls grid={maze.grid} cs={cs} color={color} />

        {/* exit */}
        <View
          style={{
            position: "absolute",
            left: maze.exit[1] * cs,
            top: maze.exit[0] * cs,
            width: cs,
            height: cs,
            backgroundColor: "#2ecc71",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={{ fontSize: cs * 0.6 }}>🏁</Text>
        </View>

        {/* hearts */}
        {maze.items.map((it) =>
          collected.includes(`${level}-${it.r}-${it.c}`) ? null : (
            <Text
              key={`${it.r}-${it.c}`}
              style={{
                position: "absolute",
                left: it.c * cs,
                top: it.r * cs,
                width: cs,
                height: cs,
                textAlign: "center",
                fontSize: cs * 0.6,
                lineHeight: cs,
              }}
            >
              {it.type === "blue" ? "💙" : "❤️"}
            </Text>
          )
        )}

        {/* ball */}
        <View
          style={{
            position: "absolute",
            left: ball.x - ballR,
            top: ball.y - ballR,
            width: ballR * 2,
            height: ballR * 2,
            borderRadius: ballR,
            backgroundColor: "#ffd400",
            borderWidth: 1.5,
            borderColor: "#fff",
          }}
        />
      </View>

      {/* Stats */}
      <View style={{ width: COLS * cs, marginTop: 10, backgroundColor: "#1d1d1d", borderRadius: 8, padding: 10 }}>
        <Text style={{ color: "#fff", fontSize: 18 }}>Maze: {level} of 3</Text>
        <Text style={{ color: "#6fa8ff", fontSize: 16 }}>
          Blue hearts: {blue} x {BLUE_PTS} = {blue * BLUE_PTS}
        </Text>
        <Text style={{ color: "#ff6b8a", fontSize: 16 }}>
          Red hearts: {red} x {RED_PTS} = {red * RED_PTS}
        </Text>
        <Text style={{ color: "#fff", fontSize: 16 }}>Maze completion points: {levelPts}</Text>
        <Text style={{ color: "#ffd400", fontSize: 22, fontWeight: "bold", marginTop: 4 }}>
          Total score: {total}
        </Text>
      </View>

      {/* Completion message */}
      {finished && (
        <View style={{ width: COLS * cs, marginTop: 10, backgroundColor: "#12331f", borderRadius: 8, padding: 10 }}>
          <Text style={{ color: "#2ecc71", fontSize: 20, fontWeight: "bold" }}>🎉 All mazes complete!</Text>
          <Text style={{ color: "#fff", fontSize: 18 }}>Final score: {total}</Text>
          <TouchableOpacity
            onPress={restart}
            style={{ backgroundColor: "#2ecc71", padding: 10, borderRadius: 6, marginTop: 8, alignItems: "center" }}
          >
            <Text style={{ fontWeight: "bold" }}>Play Again</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Save score */}
      <View
        onLayout={(e) => (saveRowY.current = e.nativeEvent.layout.y)}
        style={{ width: COLS * cs, marginTop: 10, flexDirection: "row" }}
      >
        <TextInput
          value={name}
          onChangeText={(t) => {
            setName(t);
            setSaved(false);
          }}
          onFocus={() => setTimeout(scrollToNameBox, 300)}
          placeholder="Player name"
          placeholderTextColor="#888"
          style={{ flex: 1, backgroundColor: "#fff", borderRadius: 6, paddingHorizontal: 10, fontSize: 16, height: 44 }}
        />
        <TouchableOpacity
          onPress={saveScore}
          style={{ backgroundColor: "#0b88ef", borderRadius: 6, marginLeft: 8, paddingHorizontal: 14, justifyContent: "center" }}
        >
          <Text style={{ color: "#fff", fontWeight: "bold", fontSize: 16 }}>Save Score</Text>
        </TouchableOpacity>
      </View>
      {saved && <Text style={{ color: "#2ecc71", marginTop: 4 }}>Score saved!</Text>}

      {/* Top 3 */}
      <View style={{ width: COLS * cs, marginTop: 10, backgroundColor: "#1d1d1d", borderRadius: 8, padding: 10 }}>
        <Text style={{ color: "#fff", fontSize: 18, fontWeight: "bold", fontFamily: mono }}>🏆 Top 3 Scores</Text>
        {scores.length === 0 && <Text style={{ color: "#888", fontFamily: mono, fontSize: 16 }}>No scores yet</Text>}
        {scores.slice(0, 3).map((s, i) => (
          <Text key={i} style={{ color: "#ffd400", fontFamily: mono, fontSize: 18, marginTop: 2 }}>
            {i + 1}. {s.name} - {s.score}
          </Text>
        ))}
      </View>
    </ScrollView>
  );
}
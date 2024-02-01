function setup(){
    createCanvas(400,400)
    
}


function draw(){
    background('skyblue')
    fill('green')
    for (const baloon of Game.baloons) {
        baloon.drawBaloon()
        baloon.run(Game.score)
        if (baloon.y <= baloon.size/2 && baloon.color !== 'red' && baloon.color !== 'black' && baloon.color !== 'yellow' ) {
            clearInterval(interval)
            background('red')
            noLoop();
            Game.baloons.length = 0;
            background('red')
            let finalScore = Game.score;
            Game.score = '';
            textSize(30);
            fill('white');
            textAlign(CENTER, CENTER);
            text("YOU LOOSE MAAATE((" , 200,100)
            text('FINAL SCORE:', 200, 200);
            textSize(50);
            fill('white');
            textAlign(CENTER, CENTER);
            text(finalScore, 200, 250);
        }
    }
    // addEventListener!!!
    textSize(22)
    fill('black')
    text(Game.score,  20, 40);  
    if (frameCount % 74 == 0) {
        Game.addCommonBaloon()
    }
    if (frameCount % 101 == 0) {
        Game.addUniqueBaloon()
    }
    if (frameCount % 124 == 0) {
        Game.addEvilBaloon()
    }
    if (frameCount % 1000 == 0) {
        Game.addDeathBaloon()
    }
    if (frameCount % 1100 == 0) {
        Game.addLuckyBaloon()
    }
    Game.winnnerCheck()


}
function sendStat() {
    let statistic = {
        blue: Game.countOfBlue,
        black: Game.countOfBlack,
        red: Game.countOfRed,
        green: Game.countOfGreen,
        yellow: Game.countOfYellow,
        mouseClick: Game.countOfMouseClick,
    }
    fetch('/statistic', {
        method: 'POST',
        headers: {
            "Content-Type": "application/json"
          },
        body: JSON.stringify(statistic)
    })

}
let interval;

interval = setInterval(()=>{
    sendStat()
}, 2000)



class Game{
    static baloons = []
    static score = 0
    static countOfBlue = 0
    static countOfRed = 0
    static countOfBlack = 0
    static countOfGreen= 0
    static countOfYellow = 0
    static countOfMouseClick = 0

    static addPauseButton(){
        let pausen = new Pause()
    }

    static addCommonBaloon(){
        let common = new CommonBaloon(50, 'blue')
        this.baloons.push(common)
    }
    static addUniqueBaloon(){
        let unique = new UniqueBaloon(25, 'green')
        this.baloons.push(unique)
    }
    static addEvilBaloon(){
        let evil = new EvilBaloon(50, 'red')
        this.baloons.push(evil)
    }
    static addDeathBaloon(){
        let death = new DeathBaloon(50, 'black')
        this.baloons.push(death)
    }
    static addLuckyBaloon(){
        let lucky = new LuckyBaloon(50, 'yellow')
        this.baloons.push(lucky)
    }
    
    static checkBaloon(){
        Game.baloons.forEach((baloon ,index)=>{
            let distance = dist(baloon.x , baloon.y ,mouseX, mouseY)
            if (distance <=baloon.size / 2) {
                baloon.burst(index)
            }
        })
    }
    static winnnerCheck(){
        if (this.score >= 250){
            noLoop()
            background('Green')
            textSize(30);
            fill('white');
            textAlign(CENTER, CENTER);
            text("YOU WIN, YAHOOOO!!!" , 200,100)
            
        
        }
    }
}
function mousePressed(){
    
    Game.checkBaloon()
    if (!isLooping()){
        Game.score = 0 
        loop()
        interval = setInterval(()=>{
            sendStat()
        }, 2000)
    }
    Game.countOfMouseClick += 1;
}

class CommonBaloon{
    constructor(size ,color){
        this.x = random(width)
        this.y = random(height - 10, height + 30)
        this.size = size
        this.color = color
        
    }

    drawBaloon(){
        fill(this.color)
        ellipse(this.x, this.y , this.size)
        line(this.x, this.y + this.size/2, this.x, this.y + this.size+20 )
    }
    run(score){
        if (score < 100) {
            this.y -= 1
        }else if(score >= 100 && score < 200) {
            this.y -= 1.5
        }else{
            this.y -= 2 
        }
        
    }
    burst(index){
        Game.score += 1
        Game.baloons.splice(index , 1)
        Game.countOfBlue += 1
    }
} 

class UniqueBaloon extends CommonBaloon{
    constructor(size ,color){
        super(size ,color)
    }
    burst(index){
        Game.score += 10
        Game.baloons.splice(index , 1)
        Game.countOfGreen += 1
    
    }
}

class EvilBaloon extends CommonBaloon{
    constructor(size ,color){
        super(size ,color)
    }
    burst(index){
        Game.score -= 10
        Game.baloons.splice(index , 1)
        Game.countOfRed += 1
    }
}

class DeathBaloon extends CommonBaloon{
    constructor(size , color){
        super(size,color)
    }
    burst(index){
        Game.score -= 100
        Game.baloons.splice(index, 1)
        Game.countOfBlack += 1
    }
}

class LuckyBaloon extends CommonBaloon{
    constructor(size ,color){
        super(size ,color)
    }
    run(){
        this.y -=2
    }
    burst(index){
        Game.score += 125
        Game.baloons.splice(index , 1)
        Game.countOfYellow+= 1
    }
}
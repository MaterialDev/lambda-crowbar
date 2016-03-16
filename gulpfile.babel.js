let gulp = require('gulp');
var plugins = require('gulp-load-plugins')();//loads all plugins matching gulp-*
let mocha = require('gulp-mocha');
let tsm = require('teamcity-service-messages');
let packageJson = require('./package.json');

gulp.task('default', ['test']);

gulp.task('test', () => {
  return gulp.src('test/**/*.js', {read: false})
    .pipe(mocha());
});

gulp.task('build:babel', (callback) => {
  gulp.src(['src/**/*.js'], {base: "./src"})
    .pipe(plugins.sourcemaps.init())
    .pipe(plugins.babel({presets:['es2015']}))
    .pipe(plugins.sourcemaps.write("."))
    .pipe(gulp.dest('build'))
    .on('end', () => {callback()});
});

gulp.task('testTeamCity', () => {
  return gulp.src('test/**/*.js', {read: false})
    .pipe(mocha({reporter: 'mocha-teamcity-reporter'}));
});

gulp.task('setBuildNumber', () => {
  tsm.buildNumber(packageJson.version + '.{build.number}')
});

gulp.task('npmrc', () => {
  let npmKey = process.env.NPM_KEY;
  require('fs').writeFileSync('.npmrc', npmKey);
  console.log(npmKey);
});